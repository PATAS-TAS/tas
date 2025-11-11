#!/usr/bin/env python3
"""
Enhanced auto-improvement with better error handling, notifications, and rollback.
"""

import json
import sys
import re
import shutil
import subprocess
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


class EnhancedAutoImprover:
    """Enhanced auto-improvement with rollback and notifications."""
    
    def __init__(self):
        self.feedback_db = FeedbackDB()
        self.analyzer = FeedbackAnalyzer()
        self.improver = RuleImprover()
        self.rules_file = Path("app/regex_patterns.py")
        self.backup_dir = Path("rules/backups")
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        self.rollback_dir = Path("rules/rollbacks")
        self.rollback_dir.mkdir(parents=True, exist_ok=True)
        
        self.auto_apply_threshold = {
            "min_feedback": 20,
            "min_confidence": 0.8,
            "max_fpr_increase": 0.01,
        }
    
    def notify(self, message: str, level: str = "info"):
        """Send notification (can be extended to email/slack/etc)."""
        timestamp = datetime.now(timezone.utc).isoformat()
        log_msg = f"[{level.upper()}] {timestamp}: {message}"
        logger.info(log_msg)
        
        # Write to notification log
        notify_log = Path("logs/notifications.log")
        notify_log.parent.mkdir(parents=True, exist_ok=True)
        with open(notify_log, 'a') as f:
            f.write(log_msg + "\n")
    
    def run_quality_test(self) -> Dict[str, Any]:
        """Run quality test before/after improvements."""
        try:
            result = subprocess.run(
                ["python3", "scripts/auto_test_quality.py"],
                capture_output=True,
                text=True,
                timeout=60
            )
            if result.returncode == 0:
                return {"status": "passed", "output": result.stdout}
            else:
                return {"status": "failed", "output": result.stdout, "error": result.stderr}
        except Exception as e:
            logger.error(f"Quality test failed: {e}")
            return {"status": "error", "error": str(e)}
    
    def rollback(self, backup_file: Path) -> bool:
        """Rollback to previous rules version."""
        try:
            if not backup_file.exists():
                logger.error(f"Backup file not found: {backup_file}")
                return False
            
            # Create rollback backup
            rollback_backup = self.rollback_dir / f"rollback_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.py"
            if self.rules_file.exists():
                shutil.copy2(self.rules_file, rollback_backup)
            
            # Restore from backup
            shutil.copy2(backup_file, self.rules_file)
            logger.info(f"Rolled back to: {backup_file}")
            self.notify(f"Rolled back rules to {backup_file.name}", "warning")
            return True
        except Exception as e:
            logger.error(f"Rollback failed: {e}")
            return False
    
    def auto_improve_with_safety(self, dry_run: bool = False) -> Dict[str, Any]:
        """Auto-improve with quality gates and rollback."""
        logger.info("Starting enhanced auto-improvement cycle...")
        
        # Pre-flight check: Quality test before changes
        logger.info("Running pre-flight quality test...")
        pre_test = self.run_quality_test()
        if pre_test.get("status") == "failed":
            logger.warning("Pre-flight quality test failed, skipping improvements")
            return {
                "status": "skipped",
                "reason": "pre_flight_test_failed",
                "pre_test": pre_test
            }
        
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
        
        # Filter auto-applicable improvements
        auto_applicable = []
        for improvement in improvements:
            if self._should_auto_apply(improvement):
                auto_applicable.append(improvement)
        
        if not auto_applicable:
            logger.info("No improvements safe for auto-application")
            return {
                "status": "no_auto_applicable",
                "total_improvements": len(improvements),
                "auto_applicable": 0
            }
        
        # Create backup
        if not dry_run:
            backup_file = self._backup_rules()
            self.notify(f"Created backup: {backup_file.name}", "info")
        
        # Apply improvements
        applied = []
        failed = []
        
        for improvement in auto_applicable:
            rule_name = improvement["rule_name"]
            suggestions = improvement["suggestions"]
            
            for suggestion in suggestions:
                if suggestion.get("type") == "adjust_weight":
                    new_weight = suggestion.get("suggested_weight")
                    if new_weight:
                        if not dry_run:
                            success = self._apply_weight_adjustment(rule_name, new_weight)
                            if success:
                                applied.append({
                                    "rule": rule_name,
                                    "type": "weight_adjustment",
                                    "new_weight": new_weight,
                                    "old_weight": improvement.get("current_weight")
                                })
                                self.notify(f"Applied weight adjustment: {rule_name} -> {new_weight:.2f}", "info")
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
        
        # Post-flight check: Quality test after changes
        if not dry_run and applied:
            logger.info("Running post-flight quality test...")
            post_test = self.run_quality_test()
            
            if post_test.get("status") == "failed":
                logger.error("Post-flight quality test failed, rolling back...")
                if backup_file:
                    self.rollback(backup_file)
                return {
                    "status": "rolled_back",
                    "reason": "post_flight_test_failed",
                    "applied": applied,
                    "post_test": post_test,
                    "backup_file": str(backup_file)
                }
            else:
                self.notify(f"Applied {len(applied)} improvements, quality tests passed", "success")
        
        result = {
            "status": "completed",
            "dry_run": dry_run,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "pre_test": pre_test,
            "post_test": post_test if not dry_run and applied else None,
            "total_improvements": len(improvements),
            "auto_applicable": len(auto_applicable),
            "applied": applied,
            "failed": failed
        }
        
        if not dry_run and applied:
            result["backup_file"] = str(backup_file)
        
        logger.info(f"Enhanced auto-improvement complete: {len(applied)} applied, {len(failed)} failed")
        return result
    
    def _should_auto_apply(self, improvement: Dict[str, Any]) -> bool:
        """Check if improvement is safe to apply."""
        rule_name = improvement.get("rule_name")
        suggestions = improvement.get("suggestions", [])
        
        if not suggestions:
            return False
        
        rule_stats = self.feedback_db.get_rule_stats().get(rule_name, {})
        total_matches = rule_stats.get("total_matches", 0)
        if total_matches < self.auto_apply_threshold["min_feedback"]:
            return False
        
        safe_suggestions = [s for s in suggestions if s.get("type") == "adjust_weight"]
        if not safe_suggestions:
            return False
        
        current_fpr = rule_stats.get("false_positive_rate", 0)
        if current_fpr > 0.10:
            return True
        
        return False
    
    def _backup_rules(self) -> Path:
        """Create backup of current rules file."""
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        backup_file = self.backup_dir / f"regex_patterns_{timestamp}.py"
        shutil.copy2(self.rules_file, backup_file)
        logger.info(f"Backup created: {backup_file}")
        return backup_file
    
    def _apply_weight_adjustment(self, rule_name: str, new_weight: float) -> bool:
        """Apply weight adjustment to a rule."""
        try:
            with open(self.rules_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            pattern = rf'(re\.compile\([^)]+\),\s*["\']{re.escape(rule_name)}["\'],\s*)([\d.]+)'
            
            def replace_weight(match):
                return f"{match.group(1)}{new_weight:.2f}"
            
            new_content = re.sub(pattern, replace_weight, content)
            
            if new_content == content:
                logger.warning(f"Rule '{rule_name}' not found or weight unchanged")
                return False
            
            with open(self.rules_file, 'w', encoding='utf-8') as f:
                f.write(new_content)
            
            logger.info(f"Applied weight adjustment: {rule_name} -> {new_weight:.2f}")
            return True
            
        except Exception as e:
            logger.error(f"Error applying weight adjustment: {e}")
            return False


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="Enhanced automatic rule improvement")
    parser.add_argument("--dry-run", action="store_true", help="Dry run mode")
    parser.add_argument("--min-feedback", type=int, default=20, help="Minimum feedback")
    
    args = parser.parse_args()
    
    improver = EnhancedAutoImprover()
    if args.min_feedback:
        improver.auto_apply_threshold["min_feedback"] = args.min_feedback
    
    result = improver.auto_improve_with_safety(dry_run=args.dry_run)
    
    print("\n" + "=" * 60)
    print("ENHANCED AUTO-IMPROVEMENT SUMMARY")
    print("=" * 60)
    print(f"Status: {result['status']}")
    if result.get('applied'):
        print(f"Applied: {len(result['applied'])} improvements")
        for item in result['applied']:
            print(f"  - {item['rule']}: weight {item.get('old_weight')} -> {item.get('new_weight')}")
    if result.get('failed'):
        print(f"Failed: {len(result['failed'])} improvements")
    if result.get('status') == 'rolled_back':
        print("⚠️  Changes rolled back due to quality test failure")
    print("=" * 60)


if __name__ == "__main__":
    main()

