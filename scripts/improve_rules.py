#!/usr/bin/env python3
"""
Automatic rule improvement based on feedback analysis.
Suggests rule modifications to reduce FP/FN rates.
"""

import json
import sys
import re
import argparse
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional, Tuple
import logging

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.feedback_db import FeedbackDB
from app.regex_patterns import regex_patterns
from scripts.analyze_feedback import FeedbackAnalyzer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class RuleImprover:
    """Suggests rule improvements based on feedback analysis."""
    
    def __init__(self):
        self.feedback_db = FeedbackDB()
        self.analyzer = FeedbackAnalyzer()
        self.suggestions_dir = Path("rules/suggestions")
        self.suggestions_dir.mkdir(parents=True, exist_ok=True)
    
    def analyze_fp_examples(self, rule_name: str, limit: int = 20) -> Dict[str, Any]:
        """Analyze false positive examples for a rule."""
        fp_entries = self.feedback_db.get_feedback(error_type="fp", limit=1000)
        rule_fp = [e for e in fp_entries if rule_name in e.get("matched_rules", [])][:limit]
        
        if not rule_fp:
            return {"count": 0, "patterns": []}
        
        # Extract common patterns
        patterns = {
            "common_prefixes": {},
            "common_suffixes": {},
            "common_words": {},
            "length_distribution": [],
            "character_patterns": {}
        }
        
        for entry in rule_fp:
            text = entry["text"]
            patterns["length_distribution"].append(len(text))
            
            # Word analysis
            words = text.lower().split()
            for word in words:
                if len(word) > 2:
                    patterns["common_words"][word] = patterns["common_words"].get(word, 0) + 1
            
            # Character patterns
            if re.search(r'\d+', text):
                patterns["character_patterns"]["has_numbers"] = patterns["character_patterns"].get("has_numbers", 0) + 1
            if re.search(r'[A-Z]', text):
                patterns["character_patterns"]["has_uppercase"] = patterns["character_patterns"].get("has_uppercase", 0) + 1
            if '@' in text:
                patterns["character_patterns"]["has_email"] = patterns["character_patterns"].get("has_email", 0) + 1
        
        # Get top patterns
        top_words = sorted(patterns["common_words"].items(), key=lambda x: x[1], reverse=True)[:10]
        
        return {
            "count": len(rule_fp),
            "examples": [e["text"][:100] for e in rule_fp[:5]],
            "patterns": {
                "top_words": top_words,
                "avg_length": sum(patterns["length_distribution"]) / len(patterns["length_distribution"]) if patterns["length_distribution"] else 0,
                "character_patterns": patterns["character_patterns"]
            }
        }
    
    def analyze_fn_examples(self, rule_name: str, limit: int = 20) -> Dict[str, Any]:
        """Analyze false negative examples for a rule."""
        fn_entries = self.feedback_db.get_feedback(error_type="fn", limit=1000)
        rule_fn = [e for e in fn_entries if rule_name in e.get("matched_rules", [])][:limit]
        
        if not rule_fn:
            return {"count": 0, "patterns": []}
        
        # Extract missed patterns
        patterns = {
            "common_words": {},
            "common_phrases": {},
            "character_patterns": {}
        }
        
        for entry in rule_fn:
            text = entry["text"].lower()
            
            # Word analysis
            words = text.split()
            for word in words:
                if len(word) > 2:
                    patterns["common_words"][word] = patterns["common_words"].get(word, 0) + 1
            
            # Phrase analysis (2-3 word phrases)
            for i in range(len(words) - 1):
                phrase = " ".join(words[i:i+2])
                if len(phrase) > 3:
                    patterns["common_phrases"][phrase] = patterns["common_phrases"].get(phrase, 0) + 1
        
        top_words = sorted(patterns["common_words"].items(), key=lambda x: x[1], reverse=True)[:10]
        top_phrases = sorted(patterns["common_phrases"].items(), key=lambda x: x[1], reverse=True)[:10]
        
        return {
            "count": len(rule_fn),
            "examples": [e["text"][:100] for e in rule_fn[:5]],
            "patterns": {
                "top_words": top_words,
                "top_phrases": top_phrases
            }
        }
    
    def suggest_rule_modifications(self, rule_name: str) -> Dict[str, Any]:
        """Suggest modifications to improve a rule."""
        # Find current rule pattern
        current_pattern = None
        current_weight = 0.0
        
        for pattern, name, weight in regex_patterns.patterns:
            if name.lower() == rule_name.lower():
                current_pattern = pattern
                current_weight = weight
                break
        
        if not current_pattern:
            logger.warning(f"Rule '{rule_name}' not found in regex_patterns")
            return {"suggestions": []}
        
        # Analyze FP and FN
        fp_analysis = self.analyze_fp_examples(rule_name)
        fn_analysis = self.analyze_fn_examples(rule_name)
        
        suggestions = []
        
        # Suggestions for reducing FP
        if fp_analysis["count"] > 0:
            # Check if rule is too broad
            if fp_analysis["patterns"].get("avg_length", 0) < 20:
                suggestions.append({
                    "type": "reduce_fp",
                    "action": "Add minimum length requirement",
                    "current_pattern": str(current_pattern),
                    "suggested_modification": f"{current_pattern}(?=.{{20,}})",
                    "reason": "Many FP examples are very short"
                })
            
            # Check for common FP words that should be excluded
            top_fp_words = [w[0] for w in fp_analysis["patterns"].get("top_words", [])[:3]]
            if top_fp_words:
                suggestions.append({
                    "type": "reduce_fp",
                    "action": "Add negative lookahead for common FP words",
                    "current_pattern": str(current_pattern),
                    "suggested_modification": f"{current_pattern}(?!.*({'|'.join(top_fp_words)}))",
                    "reason": f"Common FP words: {', '.join(top_fp_words)}"
                })
        
        # Suggestions for reducing FN
        if fn_analysis["count"] > 0:
            # Check for missed phrases
            top_phrases = [p[0] for p in fn_analysis["patterns"].get("top_phrases", [])[:3]]
            if top_phrases:
                suggestions.append({
                    "type": "reduce_fn",
                    "action": "Add patterns for missed phrases",
                    "current_pattern": str(current_pattern),
                    "suggested_addition": "|".join([re.escape(p) for p in top_phrases]),
                    "reason": f"Common missed phrases: {', '.join(top_phrases)}"
                })
            
            # Check for missed words
            top_words = [w[0] for w in fn_analysis["patterns"].get("top_words", [])[:5]]
            if top_words:
                suggestions.append({
                    "type": "reduce_fn",
                    "action": "Expand pattern to include missed words",
                    "current_pattern": str(current_pattern),
                    "suggested_addition": "|".join([re.escape(w) for w in top_words]),
                    "reason": f"Common missed words: {', '.join(top_words)}"
                })
        
        # Weight adjustment suggestions
        rule_stats = self.feedback_db.get_rule_stats().get(rule_name, {})
        if rule_stats:
            fpr = rule_stats.get("false_positive_rate", 0)
            if fpr > 0.05 and current_weight > 0.3:
                suggestions.append({
                    "type": "adjust_weight",
                    "action": "Reduce rule weight",
                    "current_weight": current_weight,
                    "suggested_weight": max(0.1, current_weight * 0.7),
                    "reason": f"High FPR ({fpr:.1%}) suggests rule is too aggressive"
                })
        
        return {
            "rule_name": rule_name,
            "current_pattern": str(current_pattern),
            "current_weight": current_weight,
            "fp_analysis": fp_analysis,
            "fn_analysis": fn_analysis,
            "suggestions": suggestions
        }
    
    def generate_improvement_report(self, output_file: Optional[str] = None) -> Path:
        """Generate comprehensive improvement report."""
        logger.info("Generating rule improvement suggestions...")
        
        analysis = self.analyzer.analyze_rule_performance()
        
        improvements = []
        
        for rule in analysis["problematic_rules"]:
            rule_name = rule["name"]
            logger.info(f"Analyzing rule: {rule_name}")
            
            suggestion = self.suggest_rule_modifications(rule_name)
            improvements.append(suggestion)
        
        report = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "total_rules_analyzed": len(improvements),
            "improvements": improvements
        }
        
        if not output_file:
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            output_file = self.suggestions_dir / f"improvements_{timestamp}.json"
        
        output_path = Path(output_file)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_path, 'w') as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        
        # Generate markdown summary
        md_path = output_path.with_suffix('.md')
        self._generate_markdown_report(report, md_path)
        
        logger.info(f"Improvement report saved: {output_path}")
        logger.info(f"Markdown summary: {md_path}")
        
        return output_path
    
    def _generate_markdown_report(self, report: Dict[str, Any], output_path: Path):
        """Generate markdown improvement report."""
        md = f"""# Rule Improvement Suggestions

**Generated**: {report['timestamp']}
**Rules Analyzed**: {report['total_rules_analyzed']}

"""
        
        for improvement in report['improvements']:
            if not improvement.get('suggestions'):
                continue
            
            md += f"## {improvement['rule_name']}\n\n"
            md += f"**Current Pattern**: `{improvement['current_pattern']}`\n"
            md += f"**Current Weight**: {improvement['current_weight']}\n\n"
            
            md += "### False Positives\n\n"
            md += f"- **Count**: {improvement['fp_analysis']['count']}\n"
            if improvement['fp_analysis']['examples']:
                md += "- **Examples**:\n"
                for ex in improvement['fp_analysis']['examples'][:3]:
                    md += f"  - `{ex}`\n"
            md += "\n"
            
            md += "### False Negatives\n\n"
            md += f"- **Count**: {improvement['fn_analysis']['count']}\n"
            if improvement['fn_analysis']['examples']:
                md += "- **Examples**:\n"
                for ex in improvement['fn_analysis']['examples'][:3]:
                    md += f"  - `{ex}`\n"
            md += "\n"
            
            md += "### Suggestions\n\n"
            for suggestion in improvement['suggestions']:
                md += f"**{suggestion['action']}**\n\n"
                md += f"- **Reason**: {suggestion['reason']}\n"
                if 'suggested_modification' in suggestion:
                    md += f"- **Suggested**: `{suggestion['suggested_modification']}`\n"
                if 'suggested_weight' in suggestion:
                    md += f"- **New Weight**: {suggestion['suggested_weight']}\n"
                md += "\n"
        
        with open(output_path, 'w') as f:
            f.write(md)


def main():
    parser = argparse.ArgumentParser(description="Generate rule improvement suggestions")
    parser.add_argument("--rule", type=str, help="Analyze specific rule only")
    parser.add_argument("--output", type=str, help="Output file path")
    
    args = parser.parse_args()
    
    improver = RuleImprover()
    
    if args.rule:
        suggestion = improver.suggest_rule_modifications(args.rule)
        print(json.dumps(suggestion, indent=2))
    else:
        improver.generate_improvement_report(args.output)


if __name__ == "__main__":
    main()

