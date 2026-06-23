from typing import Dict, List, Optional, Any
from datetime import datetime, timezone
from app.rule_importer import rule_importer
import logging
import hashlib
from collections import defaultdict

logger = logging.getLogger(__name__)


class RuleOrchestrator:
    def __init__(self):
        self.active_rules: Dict[str, Any] = {}
        self.shadow_rules: Dict[str, Any] = {}
        self.shadow_patterns: List[tuple] = []  # Compiled shadow patterns
        self.rule_versions: Dict[str, str] = {}
        self.canary_percentage: float = 0.10  # Default 10% canary
        self.false_positive_count: int = 0
        self.false_positive_threshold: int = 10
        
        # Shadow rules metrics storage
        self.shadow_metrics: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
            "total_checked": 0,
            "true_positives": 0,
            "false_positives": 0,
            "true_negatives": 0,
            "false_negatives": 0,
            "precision": 0.0,
            "recall": 0.0,
            "f1_score": 0.0,
            "last_updated": None
        })
        
    async def load_rules_from_patas(self, patas_url: str, api_key: Optional[str] = None) -> None:
        """Load rules from PATAS."""
        rule_importer.patas_url = patas_url
        rule_importer.api_key = api_key
        
        try:
            ruleset = await rule_importer.fetch_rules()
            self.active_rules = ruleset
            self.rule_versions[ruleset.get("version", "0.0.0")] = datetime.now(timezone.utc).isoformat()
            logger.info(f"Loaded ruleset version {ruleset.get('version')} from PATAS")
        except Exception as e:
            logger.error(f"Failed to load rules from PATAS: {e}")
    
    def enable_shadow_rules(self, ruleset: Dict[str, Any]) -> None:
        """Enable shadow rules for testing without affecting users."""
        self.shadow_rules = ruleset
        self.shadow_patterns = []
        
        # Compile shadow patterns from ruleset
        import re
        for rule in ruleset.get("rules", []):
            try:
                pattern_str = rule.get("pattern", "")
                reason = rule.get("reason", "Shadow rule")
                score = rule.get("score", 0.5)
                compiled = re.compile(pattern_str, re.IGNORECASE)
                self.shadow_patterns.append((compiled, reason, score))
            except Exception as e:
                logger.warning(f"Failed to compile shadow rule: {e}")
        
        logger.info(f"Shadow rules enabled: {len(self.shadow_patterns)} compiled patterns")
    
    def set_canary_percentage(self, percentage: float) -> None:
        """Set canary rollout percentage (0.0 = 0%, 1.0 = 100%)."""
        if 0.0 <= percentage <= 1.0:
            self.canary_percentage = percentage
            logger.info(f"Canary percentage set to {percentage * 100:.1f}%")
        else:
            logger.warning(f"Invalid canary percentage: {percentage}")
    
    def should_use_shadow(self, request_id: str) -> bool:
        """Determine if request should use shadow rules (for canary)."""
        if not self.shadow_patterns:
            return False
        
        # Use consistent hash for canary distribution
        hash_value = int(hashlib.md5(request_id.encode()).hexdigest()[:8], 16) % 100
        return hash_value < (self.canary_percentage * 100)
    
    def check_shadow_rules(self, text: str) -> List[tuple]:
        """Check text against shadow rules (for logging only, no blocking)."""
        if not self.shadow_patterns:
            return []
        
        results = []
        for pattern, reason, score in self.shadow_patterns:
            if pattern.search(text):
                results.append((reason, score))
        return results
    
    def record_shadow_result(self, rule_id: str, predicted_spam: bool, actual_spam: bool) -> None:
        """Record shadow rule result for metrics calculation."""
        metrics = self.shadow_metrics[rule_id]
        metrics["total_checked"] += 1
        
        if predicted_spam and actual_spam:
            metrics["true_positives"] += 1
        elif predicted_spam and not actual_spam:
            metrics["false_positives"] += 1
        elif not predicted_spam and not actual_spam:
            metrics["true_negatives"] += 1
        else:
            metrics["false_negatives"] += 1
        
        # Calculate precision, recall, F1
        tp = metrics["true_positives"]
        fp = metrics["false_positives"]
        fn = metrics["false_negatives"]
        
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0
        
        metrics["precision"] = precision
        metrics["recall"] = recall
        metrics["f1_score"] = f1
        metrics["last_updated"] = datetime.now(timezone.utc).isoformat()
    
    def record_false_positive(self) -> None:
        """Record false positive for auto-rollback."""
        self.false_positive_count += 1
        if self.false_positive_count >= self.false_positive_threshold:
            logger.warning(f"False positive threshold reached: {self.false_positive_count}")
            self.set_canary_percentage(0.0)
            self.false_positive_count = 0
    
    def reset_false_positive_count(self) -> None:
        """Reset false positive counter."""
        self.false_positive_count = 0
    
    def get_active_rules(self, request_id: str = "") -> Dict[str, Any]:
        """Get active rules (shadow if canary, otherwise active)."""
        if self.shadow_rules and self.should_use_shadow(request_id):
            return self.shadow_rules
        return self.active_rules
    
    def get_shadow_metrics(self) -> Dict[str, Dict[str, Any]]:
        """Get shadow rules metrics (precision/recall per rule)."""
        return dict(self.shadow_metrics)
    
    def get_shadow_summary(self) -> Dict[str, Any]:
        """Get summary of all shadow rules performance."""
        if not self.shadow_metrics:
            return {"total_rules": 0, "avg_precision": 0.0, "avg_recall": 0.0, "avg_f1": 0.0}
        
        total_rules = len(self.shadow_metrics)
        avg_precision = sum(m["precision"] for m in self.shadow_metrics.values()) / total_rules
        avg_recall = sum(m["recall"] for m in self.shadow_metrics.values()) / total_rules
        avg_f1 = sum(m["f1_score"] for m in self.shadow_metrics.values()) / total_rules
        
        return {
            "total_rules": total_rules,
            "avg_precision": round(avg_precision, 3),
            "avg_recall": round(avg_recall, 3),
            "avg_f1": round(avg_f1, 3),
            "total_checked": sum(m["total_checked"] for m in self.shadow_metrics.values())
        }
    
    def get_rule_stats(self) -> Dict[str, Any]:
        """Get rule orchestrator statistics."""
        return {
            "active_rules_count": len(self.active_rules.get("rules", [])),
            "shadow_rules_count": len(self.shadow_patterns),
            "canary_percentage": self.canary_percentage * 100,
            "false_positive_count": self.false_positive_count,
            "rule_versions": list(self.rule_versions.keys()),
            "shadow_summary": self.get_shadow_summary()
        }


rol = RuleOrchestrator()

