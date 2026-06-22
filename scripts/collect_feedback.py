#!/usr/bin/env python3
"""
Automatic feedback collection script.
Collects production data for training and improvement.

Modes:
- shadow: Collects data without affecting production decisions
- sampling: Samples a percentage of requests for manual review
- active: Collects feedback from active users
"""

import os
import sys
import json
import asyncio
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional
import logging

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.feedback_db import FeedbackDB

# Lazy import for pipeline (only needed for shadow mode)
MultiLayerPipeline = None
try:
    from app.pipeline import MultiLayerPipeline
except ImportError:
    pass

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class FeedbackCollector:
    """Collects feedback data for training and improvement."""
    
    def __init__(self):
        self.feedback_db = FeedbackDB()
        self.pipeline = None
        if MultiLayerPipeline:
            try:
                self.pipeline = MultiLayerPipeline()
            except Exception:
                pass
        self.collection_dir = Path("data/collected")
        self.collection_dir.mkdir(parents=True, exist_ok=True)
    
    async def collect_shadow_data(
        self,
        texts: List[str],
        lang: str = "en",
        metadata: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """
        Collect shadow data - classify without affecting production.
        Use for A/B testing and model improvement.
        """
        if not self.pipeline:
            raise RuntimeError("Pipeline not available. Install app dependencies.")
        
        results = []
        
        for text in texts:
            try:
                result = await self.pipeline.classify(
                    text,
                    lang=lang,
                    sender_id=metadata.get("sender_id") if metadata else None,
                    message_id=metadata.get("message_id") if metadata else None
                )
                
                results.append({
                    "text": text,
                    "prediction": result,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "lang": lang,
                    "metadata": metadata or {}
                })
            except Exception as e:
                logger.error(f"Error classifying text: {e}")
        
        return results
    
    def save_collection(self, data: List[Dict[str, Any]], filename: str):
        """Save collected data to file."""
        filepath = self.collection_dir / filename
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        logger.info(f"Saved {len(data)} items to {filepath}")
        return filepath
    
    def load_sample_texts(self, filepath: Optional[str] = None) -> List[str]:
        """Load sample texts from file or use defaults."""
        if filepath and Path(filepath).exists():
            with open(filepath) as f:
                data = json.load(f)
                if isinstance(data, list):
                    return [item if isinstance(item, str) else item.get("text", "") for item in data]
                return []
        
        # Default samples for testing
        return [
            "Buy now! 50% discount!",
            "Hello, how are you?",
            "Earn $1000 per day working from home",
            "Thanks for your help yesterday",
            "Click here: bit.ly/xxx",
            "Meeting at 3pm tomorrow",
            "Free money! No deposit required!",
            "Can we schedule a call?",
            "URGENT: Your account will be closed",
            "Looking forward to our meeting"
        ]
    
    async def collect_from_api_logs(
        self,
        log_file: str,
        sample_rate: float = 0.1
    ) -> List[Dict[str, Any]]:
        """
        Collect data from API access logs.
        sample_rate: Fraction of requests to collect (0.0-1.0)
        """
        if not Path(log_file).exists():
            logger.warning(f"Log file not found: {log_file}")
            return []
        
        collected = []
        with open(log_file) as f:
            for line in f:
                if "POST /v1/classify" in line or "POST /v1/batch" in line:
                    # Parse log line (adjust based on your log format)
                    # This is a simplified parser
                    import random
                    if random.random() < sample_rate:
                        # Extract text from log (simplified)
                        # In production, use proper log parsing
                        try:
                            # Assuming JSON logs
                            log_data = json.loads(line)
                            text = log_data.get("text") or log_data.get("body", {}).get("text")
                            if text:
                                collected.append({
                                    "text": text,
                                    "timestamp": log_data.get("timestamp"),
                                    "metadata": {
                                        "source": "api_log",
                                        "log_file": log_file
                                    }
                                })
                        except:
                            pass
        
        return collected
    
    def generate_training_dataset(
        self,
        min_feedback_per_rule: int = 10
    ) -> Dict[str, Any]:
        """
        Generate training dataset from feedback database.
        Filters rules with sufficient feedback.
        """
        rule_stats = self.feedback_db.get_rule_stats()
        summary = self.feedback_db.get_summary()
        
        # Get feedback entries
        fp_entries = self.feedback_db.get_feedback(error_type="fp", limit=1000)
        fn_entries = self.feedback_db.get_feedback(error_type="fn", limit=1000)
        
        # Group by rule
        training_data = {
            "rules": {},
            "summary": {
                "total_fp": len(fp_entries),
                "total_fn": len(fn_entries),
                "rules_with_sufficient_data": 0
            }
        }
        
        for rule_name, stats in rule_stats.items():
            if stats["total_matches"] >= min_feedback_per_rule:
                training_data["rules"][rule_name] = {
                    "stats": stats,
                    "examples": {
                        "fp": [e for e in fp_entries if rule_name in e.get("matched_rules", [])][:20],
                        "fn": [e for e in fn_entries if rule_name in e.get("matched_rules", [])][:20]
                    }
                }
                training_data["summary"]["rules_with_sufficient_data"] += 1
        
        return training_data
    
    def export_training_data(self, output_file: str = "data/training_dataset.json"):
        """Export training dataset to file."""
        dataset = self.generate_training_dataset()
        output_path = Path(output_file)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_path, 'w') as f:
            json.dump(dataset, f, indent=2, ensure_ascii=False)
        
        logger.info(f"Exported training dataset to {output_path}")
        logger.info(f"Rules with sufficient data: {dataset['summary']['rules_with_sufficient_data']}")
        return output_path


async def main():
    parser = argparse.ArgumentParser(description="Collect feedback data for training")
    parser.add_argument("--mode", choices=["shadow", "sampling", "export"], default="export",
                       help="Collection mode")
    parser.add_argument("--input", type=str, help="Input file with texts (JSON array)")
    parser.add_argument("--output", type=str, default="data/collected/shadow_data.json",
                       help="Output file")
    parser.add_argument("--sample-rate", type=float, default=0.1,
                       help="Sampling rate (0.0-1.0)")
    parser.add_argument("--log-file", type=str, help="API log file to parse")
    parser.add_argument("--min-feedback", type=int, default=10,
                       help="Minimum feedback per rule for training dataset")
    
    args = parser.parse_args()
    
    collector = FeedbackCollector()
    
    if args.mode == "shadow":
        texts = collector.load_sample_texts(args.input)
        logger.info(f"Collecting shadow data for {len(texts)} texts...")
        results = await collector.collect_shadow_data(texts)
        collector.save_collection(results, Path(args.output).name)
    
    elif args.mode == "sampling":
        if not args.log_file:
            logger.error("--log-file required for sampling mode")
            return
        logger.info(f"Sampling {args.sample_rate*100}% from {args.log_file}...")
        results = await collector.collect_from_api_logs(args.log_file, args.sample_rate)
        collector.save_collection(results, Path(args.output).name)
    
    elif args.mode == "export":
        logger.info("Exporting training dataset from feedback database...")
        collector.export_training_data(args.output)
        
        # Print summary
        summary = collector.feedback_db.get_summary()
        logger.info(f"Feedback summary:")
        logger.info(f"  Total feedback: {summary['total_feedback']}")
        logger.info(f"  False Positives: {summary['false_positives']}")
        logger.info(f"  False Negatives: {summary['false_negatives']}")
        logger.info(f"  Unique rules: {summary['unique_rules']}")


if __name__ == "__main__":
    asyncio.run(main())

