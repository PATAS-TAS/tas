from typing import Dict, List, Optional
from datetime import datetime, timedelta, timezone
from cachetools import TTLCache
import logging

logger = logging.getLogger(__name__)


class Quarantine:
    def __init__(self, max_size: int = 10000, default_ttl: int = 3600):
        self.quarantine_cache: TTLCache[str, Dict] = TTLCache(maxsize=max_size, ttl=default_ttl * 2)
        self.default_ttl = default_ttl
        self.statuses = {
            "quarantined": 0,
            "released": 1,
            "banned": 2
        }
        
    def add_to_quarantine(self, message_id: str, text: str, score: float, ttl: Optional[int] = None) -> Dict:
        """Add message to quarantine."""
        if ttl is None:
            ttl = self.default_ttl
        
        entry = {
            "message_id": message_id,
            "text": text,
            "score": score,
            "status": "quarantined",
            "quarantined_at": datetime.now(timezone.utc).isoformat(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat(),
            "ttl": ttl
        }
        
        self.quarantine_cache[message_id] = entry
        logger.info(f"Message {message_id} quarantined (score: {score:.2f}, TTL: {ttl}s)")
        return entry
    
    def get_quarantine_status(self, message_id: str) -> Optional[Dict]:
        """Get quarantine status for message."""
        return self.quarantine_cache.get(message_id)
    
    def is_quarantined(self, message_id: str) -> bool:
        """Check if message is quarantined."""
        entry = self.quarantine_cache.get(message_id)
        if not entry:
            return False
        return entry.get("status") == "quarantined"
    
    def release(self, message_id: str) -> bool:
        """Release message from quarantine."""
        entry = self.quarantine_cache.get(message_id)
        if not entry:
            return False
        
        entry["status"] = "released"
        entry["released_at"] = datetime.now(timezone.utc).isoformat()
        logger.info(f"Message {message_id} released from quarantine")
        return True
    
    def ban(self, message_id: str) -> bool:
        """Ban message (permanent quarantine)."""
        entry = self.quarantine_cache.get(message_id)
        if not entry:
            return False
        
        entry["status"] = "banned"
        entry["banned_at"] = datetime.now(timezone.utc).isoformat()
        entry["ttl"] = 86400 * 365
        logger.info(f"Message {message_id} banned")
        return True
    
    def check_expired(self) -> List[str]:
        """Check and return list of expired quarantine entries."""
        expired = []
        current_time = datetime.now(timezone.utc)
        
        for message_id, entry in list(self.quarantine_cache.items()):
            expires_at = datetime.fromisoformat(entry.get("expires_at", ""))
            if current_time > expires_at and entry.get("status") == "quarantined":
                expired.append(message_id)
                self.release(message_id)
        
        return expired
    
    def get_quarantine_stats(self) -> Dict[str, int]:
        """Get quarantine statistics."""
        stats = {"quarantined": 0, "released": 0, "banned": 0, "total": 0}
        
        for entry in self.quarantine_cache.values():
            status = entry.get("status", "quarantined")
            stats[status] = stats.get(status, 0) + 1
            stats["total"] += 1
        
        return stats
    
    def check(self, message_id: str, text: str, score: float) -> Dict[str, any]:
        """Check if message should be quarantined."""
        if self.is_quarantined(message_id):
            entry = self.get_quarantine_status(message_id)
            return {
                "is_quarantined": True,
                "status": entry.get("status"),
                "quarantined_at": entry.get("quarantined_at"),
                "expires_at": entry.get("expires_at")
            }
        
        if score >= 0.7:
            self.add_to_quarantine(message_id, text, score)
            return {
                "is_quarantined": True,
                "status": "quarantined",
                "action": "quarantined"
            }
        
        return {
            "is_quarantined": False,
            "status": "allowed"
        }


qzn = Quarantine()

