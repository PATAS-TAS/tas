import httpx
import re
from typing import Dict, List, Optional, Any
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class RuleImporter:
    def __init__(self, patas_url: str, api_key: Optional[str] = None):
        self.patas_url = patas_url.rstrip("/")
        self.api_key = api_key
        self.rules: Dict[str, Any] = {}
        self.version: str = "0.0.0"
        self.last_update: Optional[datetime] = None
        
    async def fetch_rules(self) -> Dict[str, Any]:
        """Fetch rules from PATAS /export-rules endpoint."""
        try:
            headers = {}
            if self.api_key:
                headers["X-API-Key"] = self.api_key
            
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{self.patas_url}/export-rules",
                    headers=headers
                )
                response.raise_for_status()
                ruleset = response.json()
                
                self.version = ruleset.get("version", "0.0.0")
                self.last_update = datetime.utcnow()
                self.rules = ruleset
                
                logger.info(f"Fetched ruleset version {self.version} with {len(ruleset.get('rules', []))} rules")
                return ruleset
        except Exception as e:
            logger.error(f"Error fetching rules from PATAS: {e}")
            raise
    
    def compile_rules(self) -> List[tuple]:
        """Compile ruleset into regex patterns."""
        compiled = []
        
        for rule in self.rules.get("rules", []):
            if not rule.get("enabled", True):
                continue
            
            rule_id = rule.get("id")
            pattern_str = rule.get("pattern")
            flags_str = rule.get("flags")
            weight = rule.get("weight", 0.5)
            name = rule.get("name", rule_id)
            
            if not pattern_str:
                continue
            
            flags = 0
            if flags_str == "IGNORECASE":
                flags = re.IGNORECASE
            
            try:
                pattern = re.compile(pattern_str, flags)
                compiled.append((pattern, name, weight, rule_id))
            except re.error as e:
                logger.warning(f"Invalid regex pattern for rule {rule_id}: {e}")
                continue
        
        logger.info(f"Compiled {len(compiled)} rules")
        return compiled
    
    def check_with_patas_rules(self, text: str, compiled_rules: List[tuple]) -> List[tuple]:
        """Check text against PATAS rules."""
        results = []
        
        for pattern, name, weight, rule_id in compiled_rules:
            matches = pattern.findall(text)
            if matches:
                match_count = len(matches) if isinstance(matches, list) else 1
                score = min(weight * match_count, 0.9)
                results.append((name, score, rule_id))
        
        return results


rule_importer = RuleImporter(
    patas_url="http://localhost:8000",
    api_key=None
)

