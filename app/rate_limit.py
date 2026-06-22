"""
Simple in-memory rate limiting for API endpoints.
"""
from typing import Dict, Optional
from datetime import datetime, timedelta
from collections import defaultdict
import time


class RateLimiter:
    def __init__(self):
        # Store requests per IP: {ip: [(timestamp, endpoint), ...]}
        self.requests: Dict[str, list] = defaultdict(list)
        # Cleanup old entries every N requests
        self.cleanup_counter = 0
        self.cleanup_interval = 1000
    
    def _cleanup_old_entries(self, window_seconds: int = 3600):
        """Remove entries older than window_seconds."""
        if self.cleanup_counter < self.cleanup_interval:
            self.cleanup_counter += 1
            return
        
        self.cleanup_counter = 0
        cutoff = time.time() - window_seconds
        
        for ip in list(self.requests.keys()):
            self.requests[ip] = [
                (ts, endpoint) for ts, endpoint in self.requests[ip]
                if ts > cutoff
            ]
            if not self.requests[ip]:
                del self.requests[ip]
    
    def is_allowed(
        self, 
        identifier: str, 
        max_requests: int = 100, 
        window_seconds: int = 60
    ) -> tuple[bool, Optional[int]]:
        """
        Check if request is allowed.
        
        Args:
            identifier: IP address or API key
            max_requests: Maximum requests per window
            window_seconds: Time window in seconds
        
        Returns:
            (is_allowed, remaining_requests)
        """
        self._cleanup_old_entries(window_seconds * 2)
        
        now = time.time()
        cutoff = now - window_seconds
        
        # Filter requests in current window
        self.requests[identifier] = [
            (ts, endpoint) for ts, endpoint in self.requests[identifier]
            if ts > cutoff
        ]
        
        request_count = len(self.requests[identifier])
        
        if request_count >= max_requests:
            return False, 0
        
        return True, max_requests - request_count
    
    def record_request(self, identifier: str, endpoint: str = "default"):
        """Record a request."""
        self.requests[identifier].append((time.time(), endpoint))
    
    def get_stats(self, identifier: str, window_seconds: int = 60) -> Dict:
        """Get rate limit stats for identifier."""
        now = time.time()
        cutoff = now - window_seconds
        
        requests_in_window = [
            (ts, endpoint) for ts, endpoint in self.requests[identifier]
            if ts > cutoff
        ]
        
        return {
            "requests": len(requests_in_window),
            "window_seconds": window_seconds,
            "endpoints": defaultdict(int, [
                (endpoint, sum(1 for _, e in requests_in_window if e == endpoint))
                for _, endpoint in requests_in_window
            ])
        }


# Global rate limiter instance
rate_limiter = RateLimiter()

