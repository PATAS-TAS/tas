from typing import Dict, List, Optional, Any
from datetime import datetime, timezone
from app.rule_importer import RuleImporter, rule_importer
import logging

logger = logging.getLogger(__name__)


class RuleOrchestrator:
    def __init__(self):
        self.active_rules: Dict[str, Any] = {}
        self.shadow_rules: Dict[str, Any] = {}
        self.rule_versions: Dict[str, str] = {}
        self.canary_percentage: float = 0.0
        self.false_positive_count: int = 0
        self.false_positive_threshold: int = 10
        
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
        logger.info(f"Shadow rules enabled: {len(ruleset.get('rules', []))} rules")
    
    def set_canary_percentage(self, percentage: float) -> None:
        """Set canary rollout percentage (0.0 = 0%, 1.0 = 100%)."""
        if 0.0 <= percentage <= 1.0:
            self.canary_percentage = percentage
            logger.info(f"Canary percentage set to {percentage * 100:.1f}%")
        else:
            logger.warning(f"Invalid canary percentage: {percentage}")
    
    def should_use_shadow(self, request_id: str) -> bool:
        """Determine if request should use shadow rules (for canary)."""
        if not self.shadow_rules:
            return False
        
        hash_value = hash(request_id) % 100
        return hash_value < (self.canary_percentage * 100)
    
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
    
    def get_rule_stats(self) -> Dict[str, Any]:
        """Get rule orchestrator statistics."""
        return {
            "active_rules_count": len(self.active_rules.get("rules", [])),
            "shadow_rules_count": len(self.shadow_rules.get("rules", [])),
            "canary_percentage": self.canary_percentage * 100,
            "false_positive_count": self.false_positive_count,
            "rule_versions": list(self.rule_versions.keys())
        }


rol = RuleOrchestrator()

