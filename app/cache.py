"""
Simple LRU cache for text classification results.
"""
from cachetools import LRUCache, TTLCache
from typing import Optional, Dict
import hashlib
import time


class ClassificationCache:
    def __init__(self, max_size: int = 10000, ttl: int = 3600):
        """
        Initialize cache.
        
        Args:
            max_size: Maximum number of cached items
            ttl: Time to live in seconds (1 hour default)
        """
        self.cache: TTLCache[str, Dict] = TTLCache(maxsize=max_size, ttl=ttl)
    
    def _get_key(self, text: str, lang: str = "en") -> str:
        """Generate cache key from text and language."""
        normalized = text.strip().lower()
        key_data = f"{normalized}:{lang}"
        return hashlib.md5(key_data.encode()).hexdigest()
    
    def get(self, text: str, lang: str = "en") -> Optional[Dict]:
        """Get cached result if available."""
        key = self._get_key(text, lang)
        return self.cache.get(key)
    
    def set(self, text: str, result: Dict, lang: str = "en") -> None:
        """Cache result."""
        key = self._get_key(text, lang)
        self.cache[key] = result
    
    def clear(self) -> None:
        """Clear all cached items."""
        self.cache.clear()
    
    def size(self) -> int:
        """Get current cache size."""
        return len(self.cache)


# Global cache instance (will be initialized in pipeline.py with settings)

