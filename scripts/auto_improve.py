#!/usr/bin/env python3
"""
Automatic rule improvement system.
Analyzes feedback, generates improvements, and applies safe changes automatically.
"""

import json
import sys
import re
import shutil
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
import logging

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.feedback_db import FeedbackDB
from scripts.analyze_feedback import FeedbackAnalyzer
from scripts.improve_rules import RuleImprover

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


class AutoImprover:
    """Automatically improves rules based on feedback analysis."""
    
    def __init__(self):
        self.feedback_db = FeedbackDB()
        self.analyzer = FeedbackAnalyzer()
        self.improver = RuleImprover()
        self.rules_file = Path("app/regex_patterns.py")
        self.backup_dir = Path("rules/backups")
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        self.auto_apply_threshold = {
            "min_feedback": 20,  # Minimum feedback entries
            "min_confidence": 0.8,  # Minimum confidence in improvement
            "max_fpr_increase": 0.01,  # Max allowed FPR increase
        }
    
    def should_auto_apply(self, improvement: Dict[str, Any]) -> bool:
        """Check if improvement is safe to apply automatically."""
        rule_name = improvement.get("rule_name")
        suggestions = improvement.get("suggestions", [])
        
        if not suggestions:
            return False
        
        # Check minimum feedback
        rule_stats = self.feedback_db.get_rule_stats().get(rule_name, {})
        total_matches = rule_stats.get("total_matches", 0)
        if total_matches < self.auto_apply_threshold["min_feedback"]:
            logger.info(f"Rule {rule_name}: insufficient feedback ({total_matches} < {self.auto_apply_threshold['min_feedback']})")
            return False
        
        # Check suggestion confidence
        # Simple heuristic: weight adjustments are safer than pattern changes
        safe_suggestions = [s for s in suggestions if s.get("type") == "adjust_weight"]
        if not safe_suggestions:
            logger.info(f"Rule {rule_name}: only pattern changes (require manual review)")
            return False
        
        # Check current FPR
        current_fpr = rule_stats.get("false_positive_rate", 0)
        if current_fpr > 0.10:  # Already high FPR
            logger.info(f"Rule {rule_name}: high FPR ({current_fpr:.1%}), safe to adjust")
            return True
        
        return False
    
    def backup_rules(self) -> Path:
        """Create backup of current rules file."""
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        backup_file = self.backup_dir / f"regex_patterns_{timestamp}.py"
        shutil.copy2(self.rules_file, backup_file)
        logger.info(f"Backup created: {backup_file}")
        return backup_file
    
    def apply_weight_adjustment(self, rule_name: str, new_weight: float) -> bool:
        """Apply weight adjustment to a rule."""
        try:
            # Read current rules file
            with open(self.rules_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Find rule pattern and update weight
            # Pattern: (re.compile(...), "Rule name", weight)
            pattern = rf'(re\.compile\([^)]+\),\s*["\']{re.escape(rule_name)}["\'],\s*)([\d.]+)'
            
            def replace_weight(match):
                return f"{match.group(1)}{new_weight:.2f}"
            
            new_content = re.sub(pattern, replace_weight, content)
            
            if new_content == content:
                logger.warning(f"Rule '{rule_name}' not found or weight unchanged")
                return False
            
            # Write updated content
            with open(self.rules_file, 'w', encoding='utf-8') as f:
                f.write(new_content)
            
            logger.info(f"Applied weight adjustment: {rule_name} -> {new_weight:.2f}")
            return True
            
        except Exception as e:
            logger.error(f"Error applying weight adjustment: {e}")
            return False
    
    def auto_improve(self, dry_run: bool = False) -> Dict[str, Any]:
        """Automatically improve rules based on feedback."""
        logger.info("Starting automatic rule improvement...")
        
        # Check minimum feedback
        summary = self.feedback_db.get_summary()
        if summary['total_feedback'] < self.auto_apply_threshold['min_feedback']:
            logger.info(f"Insufficient feedback: {summary['total_feedback']} < {self.auto_apply_threshold['min_feedback']}")
            return {
                "status": "skipped",
                "reason": "insufficient_feedback",
                "total_feedback": summary['total_feedback']
            }
        
        # Generate improvements
        analysis = self.analyzer.analyze_rule_performance()
        improvements = []
        
        for rule in analysis["problematic_rules"]:
            rule_name = rule["name"]
            improvement = self.improver.suggest_rule_modifications(rule_name)
            improvements.append(improvement)
        
        # Filter improvements that can be auto-applied
        auto_applicable = []
        for improvement in improvements:
            if self.should_auto_apply(improvement):
                auto_applicable.append(improvement)
        
        if not auto_applicable:
            logger.info("No improvements safe for auto-application")
            return {
                "status": "no_auto_applicable",
                "total_improvements": len(improvements),
                "auto_applicable": 0
            }
        
        # Apply improvements
        applied = []
        failed = []
        
        if not dry_run:
            backup_file = self.backup_rules()
        
        for improvement in auto_applicable:
            rule_name = improvement["rule_name"]
            suggestions = improvement["suggestions"]
            
            # Apply weight adjustments
            for suggestion in suggestions:
                if suggestion.get("type") == "adjust_weight":
                    new_weight = suggestion.get("suggested_weight")
                    if new_weight:
                        if not dry_run:
                            success = self.apply_weight_adjustment(rule_name, new_weight)
                            if success:
                                applied.append({
                                    "rule": rule_name,
                                    "type": "weight_adjustment",
                                    "new_weight": new_weight,
                                    "old_weight": improvement.get("current_weight")
                                })
                            else:
                                failed.append({
                                    "rule": rule_name,
                                    "reason": "application_failed"
                                })
                        else:
                            applied.append({
                                "rule": rule_name,
                                "type": "weight_adjustment",
                                "new_weight": new_weight,
                                "old_weight": improvement.get("current_weight"),
                                "dry_run": True
                            })
        
        result = {
            "status": "completed",
            "dry_run": dry_run,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "total_improvements": len(improvements),
            "auto_applicable": len(auto_applicable),
            "applied": applied,
            "failed": failed
        }
        
        if not dry_run and applied:
            result["backup_file"] = str(backup_file)
        
        logger.info(f"Auto-improvement complete: {len(applied)} applied, {len(failed)} failed")
        return result
    
    def run_cycle(self, dry_run: bool = False) -> Dict[str, Any]:
        """Run full improvement cycle: collect, analyze, improve."""
        logger.info("=" * 60)
        logger.info("Starting auto-improvement cycle")
        logger.info("=" * 60)
        
        # Step 1: Check feedback status
        summary = self.feedback_db.get_summary()
        logger.info(f"Feedback status: {summary['total_feedback']} total, {summary['false_positives']} FP, {summary['false_negatives']} FN")
        
        # Step 2: Run auto-improvement
        result = self.auto_improve(dry_run=dry_run)
        
        # Step 3: Save report
        report_dir = Path("reports/auto_improvement")
        report_dir.mkdir(parents=True, exist_ok=True)
        
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        report_file = report_dir / f"cycle_{timestamp}.json"
        
        with open(report_file, 'w') as f:
            json.dump(result, f, indent=2)
        
        logger.info(f"Report saved: {report_file}")
        
        return result


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="Automatic rule improvement")
    parser.add_argument("--dry-run", action="store_true", help="Dry run mode (no changes)")
    parser.add_argument("--min-feedback", type=int, default=20, help="Minimum feedback for auto-apply")
    
    args = parser.parse_args()
    
    improver = AutoImprover()
    if args.min_feedback:
        improver.auto_apply_threshold["min_feedback"] = args.min_feedback
    
    result = improver.run_cycle(dry_run=args.dry_run)
    
    # Print summary
    print("\n" + "=" * 60)
    print("AUTO-IMPROVEMENT SUMMARY")
    print("=" * 60)
    print(f"Status: {result['status']}")
    if result.get('applied'):
        print(f"Applied: {len(result['applied'])} improvements")
        for item in result['applied']:
            print(f"  - {item['rule']}: weight {item.get('old_weight')} -> {item.get('new_weight')}")
    if result.get('failed'):
        print(f"Failed: {len(result['failed'])} improvements")
    print("=" * 60)


if __name__ == "__main__":
    main()

