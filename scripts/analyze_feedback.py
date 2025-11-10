#!/usr/bin/env python3
"""
Analyze feedback data and generate improvement recommendations.
Identifies problematic rules and suggests improvements.
"""

import json
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from collections import defaultdict
import logging

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.feedback_db import FeedbackDB
from app.regex_patterns import regex_patterns

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class FeedbackAnalyzer:
    """Analyzes feedback data and generates improvement recommendations."""
    
    def __init__(self):
        self.feedback_db = FeedbackDB()
        self.reports_dir = Path("reports/feedback_analysis")
        self.reports_dir.mkdir(parents=True, exist_ok=True)
    
    def analyze_rule_performance(self) -> Dict[str, Any]:
        """Analyze performance of each rule based on feedback."""
        rule_stats = self.feedback_db.get_rule_stats()
        summary = self.feedback_db.get_summary()
        
        analysis = {
            "summary": summary,
            "rules": {},
            "problematic_rules": [],
            "recommendations": []
        }
        
        for rule_name, stats in rule_stats.items():
            total = stats["total_matches"]
            if total == 0:
                continue
            
            fp_rate = stats["false_positive_rate"]
            fn_rate = stats["false_negatives"] / total if total > 0 else 0
            
            # Identify problematic rules
            is_problematic = False
            issues = []
            
            if fp_rate > 0.05:  # FPR > 5%
                is_problematic = True
                issues.append(f"High FPR: {fp_rate:.1%}")
            
            if fn_rate > 0.10:  # FNR > 10%
                is_problematic = True
                issues.append(f"High FNR: {fn_rate:.1%}")
            
            if stats["precision"] < 0.80:  # Precision < 80%
                is_problematic = True
                issues.append(f"Low precision: {stats['precision']:.1%}")
            
            if stats["recall"] < 0.70:  # Recall < 70%
                is_problematic = True
                issues.append(f"Low recall: {stats['recall']:.1%}")
            
            rule_analysis = {
                "name": rule_name,
                "stats": stats,
                "is_problematic": is_problematic,
                "issues": issues,
                "priority": "high" if is_problematic else "normal"
            }
            
            analysis["rules"][rule_name] = rule_analysis
            
            if is_problematic:
                analysis["problematic_rules"].append(rule_analysis)
        
        # Sort problematic rules by severity
        analysis["problematic_rules"].sort(
            key=lambda x: (
                x["stats"]["false_positive_rate"],
                x["stats"]["false_negatives"] / max(x["stats"]["total_matches"], 1)
            ),
            reverse=True
        )
        
        return analysis
    
    def generate_recommendations(self, analysis: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Generate specific recommendations for improvement."""
        recommendations = []
        
        for rule in analysis["problematic_rules"]:
            rule_name = rule["name"]
            stats = rule["stats"]
            
            # Get examples
            fp_entries = self.feedback_db.get_feedback(
                error_type="fp",
                limit=10
            )
            fn_entries = self.feedback_db.get_feedback(
                error_type="fn",
                limit=10
            )
            
            rule_fp = [e for e in fp_entries if rule_name in e.get("matched_rules", [])][:5]
            rule_fn = [e for e in fn_entries if rule_name in e.get("matched_rules", [])][:5]
            
            rec = {
                "rule_name": rule_name,
                "priority": rule["priority"],
                "issues": rule["issues"],
                "current_stats": {
                    "fpr": stats["false_positive_rate"],
                    "fnr": stats["false_negatives"] / max(stats["total_matches"], 1),
                    "precision": stats["precision"],
                    "recall": stats["recall"]
                },
                "suggestions": [],
                "examples": {
                    "fp": [{"text": e["text"][:100]} for e in rule_fp],
                    "fn": [{"text": e["text"][:100]} for e in rule_fn]
                }
            }
            
            # Generate specific suggestions
            if stats["false_positive_rate"] > 0.05:
                rec["suggestions"].append({
                    "type": "reduce_fp",
                    "action": "Tighten pattern matching or add negative lookahead",
                    "examples": [e["text"][:50] for e in rule_fp[:3]]
                })
            
            if stats["false_negatives"] / max(stats["total_matches"], 1) > 0.10:
                rec["suggestions"].append({
                    "type": "reduce_fn",
                    "action": "Expand pattern matching or add more variations",
                    "examples": [e["text"][:50] for e in rule_fn[:3]]
                })
            
            if stats["precision"] < 0.80:
                rec["suggestions"].append({
                    "type": "improve_precision",
                    "action": "Add context checks or increase threshold",
                    "examples": [e["text"][:50] for e in rule_fp[:3]]
                })
            
            recommendations.append(rec)
        
        return recommendations
    
    def analyze_patterns(self) -> Dict[str, Any]:
        """Analyze common patterns in FP/FN examples."""
        fp_entries = self.feedback_db.get_feedback(error_type="fp", limit=500)
        fn_entries = self.feedback_db.get_feedback(error_type="fn", limit=500)
        
        patterns = {
            "fp_patterns": defaultdict(int),
            "fn_patterns": defaultdict(int),
            "common_words_fp": defaultdict(int),
            "common_words_fn": defaultdict(int)
        }
        
        # Analyze FP patterns
        for entry in fp_entries:
            text = entry["text"].lower()
            # Extract common spam indicators that shouldn't trigger
            if "http" in text or "www" in text:
                patterns["fp_patterns"]["urls"] += 1
            if "@" in text:
                patterns["fp_patterns"]["emails"] += 1
            if any(char.isdigit() for char in text):
                patterns["fp_patterns"]["numbers"] += 1
            
            # Common words
            words = text.split()[:10]  # First 10 words
            for word in words:
                if len(word) > 3:
                    patterns["common_words_fp"][word] += 1
        
        # Analyze FN patterns
        for entry in fn_entries:
            text = entry["text"].lower()
            # Extract common spam patterns that were missed
            if "click" in text or "link" in text:
                patterns["fn_patterns"]["click_phrases"] += 1
            if "free" in text or "discount" in text:
                patterns["fn_patterns"]["promo_words"] += 1
            if "urgent" in text or "limited" in text:
                patterns["fn_patterns"]["urgency_words"] += 1
            
            # Common words
            words = text.split()[:10]
            for word in words:
                if len(word) > 3:
                    patterns["common_words_fn"][word] += 1
        
        # Get top patterns
        patterns["top_fp_words"] = sorted(
            patterns["common_words_fp"].items(),
            key=lambda x: x[1],
            reverse=True
        )[:20]
        
        patterns["top_fn_words"] = sorted(
            patterns["common_words_fn"].items(),
            key=lambda x: x[1],
            reverse=True
        )[:20]
        
        return patterns
    
    def generate_report(self, output_file: Optional[str] = None) -> Path:
        """Generate comprehensive analysis report."""
        logger.info("Analyzing feedback data...")
        
        analysis = self.analyze_rule_performance()
        recommendations = self.generate_recommendations(analysis)
        patterns = self.analyze_patterns()
        
        report = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "summary": analysis["summary"],
            "problematic_rules_count": len(analysis["problematic_rules"]),
            "problematic_rules": analysis["problematic_rules"],
            "recommendations": recommendations,
            "patterns": patterns
        }
        
        if not output_file:
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            output_file = self.reports_dir / f"analysis_{timestamp}.json"
        
        output_path = Path(output_file)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_path, 'w') as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        
        # Generate markdown summary
        md_path = output_path.with_suffix('.md')
        self._generate_markdown_report(report, md_path)
        
        logger.info(f"Report saved: {output_path}")
        logger.info(f"Markdown summary: {md_path}")
        
        return output_path
    
    def _generate_markdown_report(self, report: Dict[str, Any], output_path: Path):
        """Generate markdown summary report."""
        md = f"""# Feedback Analysis Report

**Generated**: {report['timestamp']}

## Summary

- **Total Feedback**: {report['summary']['total_feedback']}
- **False Positives**: {report['summary']['false_positives']}
- **False Negatives**: {report['summary']['false_negatives']}
- **Unique Rules**: {report['summary']['unique_rules']}
- **Problematic Rules**: {report['problematic_rules_count']}

## Problematic Rules

"""
        
        for rule in report['problematic_rules'][:10]:
            md += f"### {rule['name']}\n\n"
            md += f"- **Issues**: {', '.join(rule['issues'])}\n"
            md += f"- **FPR**: {rule['stats']['false_positive_rate']:.1%}\n"
            md += f"- **Precision**: {rule['stats']['precision']:.1%}\n"
            md += f"- **Recall**: {rule['stats']['recall']:.1%}\n\n"
        
        md += "\n## Recommendations\n\n"
        
        for rec in report['recommendations'][:10]:
            md += f"### {rec['rule_name']}\n\n"
            md += f"**Priority**: {rec['priority']}\n\n"
            md += "**Suggestions**:\n"
            for suggestion in rec['suggestions']:
                md += f"- {suggestion['action']}\n"
            md += "\n"
        
        md += "\n## Common Patterns\n\n"
        md += "### False Positive Patterns\n\n"
        for pattern, count in list(report['patterns']['fp_patterns'].items())[:10]:
            md += f"- {pattern}: {count}\n"
        
        md += "\n### False Negative Patterns\n\n"
        for pattern, count in list(report['patterns']['fn_patterns'].items())[:10]:
            md += f"- {pattern}: {count}\n"
        
        with open(output_path, 'w') as f:
            f.write(md)


def main():
    parser = argparse.ArgumentParser(description="Analyze feedback and generate recommendations")
    parser.add_argument("--output", type=str, help="Output file path")
    parser.add_argument("--min-feedback", type=int, default=5,
                       help="Minimum feedback entries to analyze")
    
    args = parser.parse_args()
    
    analyzer = FeedbackAnalyzer()
    
    summary = analyzer.feedback_db.get_summary()
    if summary['total_feedback'] < args.min_feedback:
        logger.warning(f"Insufficient feedback data: {summary['total_feedback']} < {args.min_feedback}")
        logger.info("Collect more feedback before analysis")
        return
    
    analyzer.generate_report(args.output)


if __name__ == "__main__":
    main()

