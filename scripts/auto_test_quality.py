#!/usr/bin/env python3
"""
Automatic quality testing after rule improvements.
Tests FPR, Recall, and other metrics to ensure improvements don't degrade quality.
"""

import json
import sys
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Any
import logging

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.feedback_db import FeedbackDB
from app.metrics import MetricsCollector

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


class QualityTester:
    """Tests quality metrics after rule improvements."""
    
    def __init__(self):
        self.feedback_db = FeedbackDB()
        self.metrics = MetricsCollector()
        self.test_results_dir = Path("reports/quality_tests")
        self.test_results_dir.mkdir(parents=True, exist_ok=True)
        
        self.quality_thresholds = {
            "fpr_max": 0.05,  # Max 5% FPR
            "recall_min": 0.75,  # Min 75% recall
            "precision_min": 0.90,  # Min 90% precision
            "p95_rules_max": 250,  # Max 250ms for rules-only
            "p95_llm_max": 750,  # Max 750ms with LLM
        }
    
    def test_current_metrics(self) -> Dict[str, Any]:
        """Test current quality metrics."""
        logger.info("Testing current quality metrics...")
        
        current_metrics = self.metrics.get_current_metrics()
        rule_stats = self.feedback_db.get_rule_stats()
        
        # Calculate overall metrics
        total_fp = sum(s.get("false_positives", 0) for s in rule_stats.values())
        total_fn = sum(s.get("false_negatives", 0) for s in rule_stats.values())
        total_tp = sum(s.get("true_positives", 0) for s in rule_stats.values())
        total_tn = sum(s.get("true_negatives", 0) for s in rule_stats.values())
        
        total = total_fp + total_fn + total_tp + total_tn
        if total == 0:
            logger.warning("No feedback data for quality testing")
            return {
                "status": "insufficient_data",
                "message": "Need feedback data to test quality"
            }
        
        fpr = total_fp / (total_fp + total_tn) if (total_fp + total_tn) > 0 else 0
        recall = total_tp / (total_tp + total_fn) if (total_tp + total_fn) > 0 else 0
        precision = total_tp / (total_tp + total_fp) if (total_tp + total_fp) > 0 else 0
        f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
        
        # Get latency metrics
        p95_rules = current_metrics.get("p95_latency_rules", 0)
        p95_llm = current_metrics.get("p95_latency_llm", 0)
        
        # Check thresholds
        passed = {
            "fpr": fpr <= self.quality_thresholds["fpr_max"],
            "recall": recall >= self.quality_thresholds["recall_min"],
            "precision": precision >= self.quality_thresholds["precision_min"],
            "p95_rules": p95_rules <= self.quality_thresholds["p95_rules_max"],
            "p95_llm": p95_llm <= self.quality_thresholds["p95_llm_max"],
        }
        
        all_passed = all(passed.values())
        
        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": "passed" if all_passed else "failed",
            "metrics": {
                "fpr": round(fpr, 4),
                "recall": round(recall, 4),
                "precision": round(precision, 4),
                "f1": round(f1, 4),
                "p95_rules_ms": round(p95_rules, 2),
                "p95_llm_ms": round(p95_llm, 2),
            },
            "thresholds": self.quality_thresholds,
            "passed": passed,
            "total_feedback": total,
            "breakdown": {
                "true_positives": total_tp,
                "false_positives": total_fp,
                "true_negatives": total_tn,
                "false_negatives": total_fn,
            }
        }
        
        # Log results
        logger.info(f"Quality test results:")
        logger.info(f"  FPR: {fpr:.2%} (threshold: {self.quality_thresholds['fpr_max']:.2%}) {'✅' if passed['fpr'] else '❌'}")
        logger.info(f"  Recall: {recall:.2%} (threshold: {self.quality_thresholds['recall_min']:.2%}) {'✅' if passed['recall'] else '❌'}")
        logger.info(f"  Precision: {precision:.2%} (threshold: {self.quality_thresholds['precision_min']:.2%}) {'✅' if passed['precision'] else '❌'}")
        logger.info(f"  P95 Rules: {p95_rules:.0f}ms (threshold: {self.quality_thresholds['p95_rules_max']}ms) {'✅' if passed['p95_rules'] else '❌'}")
        logger.info(f"  P95 LLM: {p95_llm:.0f}ms (threshold: {self.quality_thresholds['p95_llm_max']}ms) {'✅' if passed['p95_llm'] else '❌'}")
        
        return result
    
    def save_test_result(self, result: Dict[str, Any]) -> Path:
        """Save test result to file."""
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        result_file = self.test_results_dir / f"quality_test_{timestamp}.json"
        
        with open(result_file, 'w') as f:
            json.dump(result, f, indent=2)
        
        logger.info(f"Test result saved: {result_file}")
        return result_file
    
    def run_test(self) -> Dict[str, Any]:
        """Run quality test and save results."""
        result = self.test_current_metrics()
        
        if result.get("status") != "insufficient_data":
            self.save_test_result(result)
        
        return result


def main():
    tester = QualityTester()
    result = tester.run_test()
    
    # Exit with error code if tests failed
    if result.get("status") == "failed":
        sys.exit(1)
    elif result.get("status") == "insufficient_data":
        sys.exit(2)
    
    sys.exit(0)


if __name__ == "__main__":
    main()

