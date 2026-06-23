from typing import Dict, Optional
from datetime import datetime, timezone
from cachetools import TTLCache
import logging

logger = logging.getLogger(__name__)


class ReputationRateSentinel:
    def __init__(self, max_size: int = 10000, ttl: int = 3600):
        self.sender_cache: TTLCache[str, list[float]] = TTLCache(maxsize=max_size, ttl=ttl)
        self.reputation: Dict[str, float] = {}
        self.burst_threshold = 5
        self.burst_window = 60
        
    def record_message(self, sender_id: str, timestamp: Optional[float] = None) -> None:
        """Record message from sender."""
        if timestamp is None:
            timestamp = datetime.now(timezone.utc).timestamp()
        
        messages = self.sender_cache.get(sender_id, [])
        messages.append(timestamp)
        self.sender_cache[sender_id] = messages
        
        self._update_reputation(sender_id, messages)
    
    def _update_reputation(self, sender_id: str, messages: list[float]) -> None:
        """Update reputation score for sender."""
        current_time = datetime.now(timezone.utc).timestamp()
        
        recent_messages = [ts for ts in messages if ts > current_time - self.burst_window]
        message_count = len(recent_messages)
        
        if message_count >= self.burst_threshold:
            burst_score = min((message_count - self.burst_threshold) / 10.0, 0.8)
            self.reputation[sender_id] = burst_score
        else:
            self.reputation[sender_id] = 0.0
    
    def check_burst(self, sender_id: str) -> tuple[bool, float]:
        """Check if sender is in burst mode."""
        messages = self.sender_cache.get(sender_id, [])
        current_time = datetime.now(timezone.utc).timestamp()
        
        recent_messages = [ts for ts in messages if ts > current_time - self.burst_window]
        message_count = len(recent_messages)
        
        is_burst = message_count >= self.burst_threshold
        burst_score = min(message_count / 10.0, 0.8) if is_burst else 0.0
        
        return is_burst, burst_score
    
    def get_reputation(self, sender_id: str) -> float:
        """Get reputation score for sender (0.0 = good, 1.0 = spam)."""
        return self.reputation.get(sender_id, 0.0)
    
    def check(self, sender_id: str, text: str) -> Dict[str, float]:
        """Check sender reputation and rate."""
        self.record_message(sender_id)
        
        is_burst, burst_score = self.check_burst(sender_id)
        reputation = self.get_reputation(sender_id)
        
        return {
            "reputation_score": reputation,
            "burst_score": burst_score,
            "is_burst": is_burst,
            "combined_score": min(reputation + burst_score * 0.5, 0.9)
        }


rrs = ReputationRateSentinel()

