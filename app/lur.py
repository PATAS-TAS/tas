import re
import hashlib
from typing import Dict, Optional, List
from urllib.parse import urlparse
import httpx
from cachetools import TTLCache
import logging

logger = logging.getLogger(__name__)


class LinkURLRisk:
    def __init__(self, max_size: int = 5000, ttl: int = 86400):
        self.url_cache: TTLCache[str, Dict] = TTLCache(maxsize=max_size, ttl=ttl)
        self.redirect_cache: TTLCache[str, str] = TTLCache(maxsize=max_size, ttl=ttl)
        
        self.risky_tlds = {".tk", ".ml", ".ga", ".cf", ".gq", ".top", ".xyz", ".click", ".download"}
        self.short_domains = {"bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "short.link"}
        
    def extract_urls(self, text: str) -> List[str]:
        """Extract URLs from text."""
        url_pattern = r"(?i)(?:https?://|www\.)[\w\-]+(\.[\w\-]+)+(?:/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?"
        urls = re.findall(url_pattern, text)
        return urls
    
    async def unpack_redirect(self, url: str) -> Optional[str]:
        """Unpack redirect (bit.ly → final URL)."""
        if url in self.redirect_cache:
            return self.redirect_cache[url]
        
        try:
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
                response = await client.get(url, allow_redirects=False)
                if response.status_code in (301, 302, 303, 307, 308):
                    final_url = response.headers.get("Location")
                    if final_url:
                        self.redirect_cache[url] = final_url
                        return final_url
        except Exception as e:
            logger.debug(f"Error unpacking redirect for {url}: {e}")
        
        return url
    
    def check_tld_risk(self, url: str) -> float:
        """Check TLD risk score."""
        parsed = urlparse(url)
        domain = parsed.netloc or parsed.path.split("/")[0]
        
        for risky_tld in self.risky_tlds:
            if domain.endswith(risky_tld):
                return 0.6
        
        return 0.0
    
    def check_short_domain(self, url: str) -> float:
        """Check if URL uses short domain."""
        parsed = urlparse(url)
        domain = parsed.netloc or parsed.path.split("/")[0]
        
        if any(short in domain for short in self.short_domains):
            return 0.4
        
        return 0.0
    
    async def hash_url_content(self, url: str) -> Optional[str]:
        """Hash URL content for comparison."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(url)
                content = response.text[:1000]
                return hashlib.md5(content.encode()).hexdigest()
        except Exception:
            return None
    
    async def check(self, text: str) -> Dict[str, float]:
        """Check URLs in text for risk."""
        urls = self.extract_urls(text)
        
        if not urls:
            return {
                "url_risk_score": 0.0,
                "url_count": 0,
                "has_short_domain": False,
                "has_risky_tld": False
            }
        
        total_risk = 0.0
        has_short = False
        has_risky = False
        
        for url in urls:
            tld_risk = self.check_tld_risk(url)
            short_risk = self.check_short_domain(url)
            
            if tld_risk > 0:
                has_risky = True
            if short_risk > 0:
                has_short = True
            
            total_risk = max(total_risk, tld_risk + short_risk)
            
            if url in self.short_domains:
                final_url = await self.unpack_redirect(url)
                if final_url and final_url != url:
                    tld_risk = max(tld_risk, self.check_tld_risk(final_url))
                    total_risk = max(total_risk, tld_risk)
        
        return {
            "url_risk_score": min(total_risk, 0.9),
            "url_count": len(urls),
            "has_short_domain": has_short,
            "has_risky_tld": has_risky
        }


lur = LinkURLRisk()

