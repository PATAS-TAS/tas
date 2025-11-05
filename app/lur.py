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
        
        # Risky TLDs (high spam/fraud probability)
        self.risky_tlds = {
            ".tk", ".ml", ".ga", ".cf", ".gq", ".top", ".xyz", ".click", ".download",
            ".guru", ".site", ".online", ".store", ".shop", ".website", ".space",
            ".info", ".biz", ".pro", ".loan", ".review", ".men", ".work", ".tech"
        }
        
        # URL shorteners (often used for spam/phishing)
        self.short_domains = {
            "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "short.link",
            "tiny.cc", "rebrand.ly", "buff.ly", "adf.ly", "qr.net", "v.gd", "hst.sh",
            "clck.ru", "clk.sh", "shrtco.de", "shorte.st", "shorturl.at", "su.pr",
            "bc.vc", "t2m.io", "t.ly", "shorten.asia", "link.short", "shr.tl", "ht.ly"
        }
        
        # Legitimate messenger domains (low risk, but still check context)
        self.legitimate_domains = {
            "t.me", "telegram.me", "telegram.org", "tg.me",
            "wa.me", "whatsapp.com", "whatsapp.net",
            "discord.gg", "discord.com", "discord.media", "discordapp.com"
        }
        
    def extract_urls(self, text: str) -> List[str]:
        """Extract URLs from text."""
        urls = []
        
        # Pattern with protocol
        url_pattern = r"(?i)(?:https?://|www\.)[\w\-]+(?:\.[\w\-]+)+(?:/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?"
        for match in re.finditer(url_pattern, text):
            urls.append(match.group(0))
        
        # Pattern without protocol (common shorteners)
        url_no_protocol = r"(?i)(?:www\.|t\.me|bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|short\.link)[\w\-\.]+(?:/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?"
        for match in re.finditer(url_no_protocol, text):
            urls.append(match.group(0))
        
        # Remove duplicates and normalize
        unique_urls = list(set(urls))
        normalized = []
        for url in unique_urls:
            if not url.startswith(("http://", "https://")):
                url = "https://" + url
            normalized.append(url)
        return normalized
    
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
        """Check TLD risk score (0-1)."""
        parsed = urlparse(url)
        domain = parsed.netloc or parsed.path.split("/")[0]
        domain_lower = domain.lower()
        
        # Check for risky TLDs
        for risky_tld in self.risky_tlds:
            if domain_lower.endswith(risky_tld):
                # High risk TLDs get higher score
                if risky_tld in {".tk", ".ml", ".ga", ".cf", ".gq"}:
                    return 0.7
                elif risky_tld in {".click", ".download", ".loan", ".review"}:
                    return 0.6
                else:
                    return 0.5
        
        return 0.0
    
    def check_short_domain(self, url: str) -> float:
        """Check if URL uses short domain (0-1)."""
        parsed = urlparse(url)
        domain = parsed.netloc or parsed.path.split("/")[0]
        domain_lower = domain.lower()
        
        for short_domain in self.short_domains:
            if domain_lower == short_domain or domain_lower.endswith("." + short_domain):
                # High-risk shorteners
                if short_domain in {"bit.ly", "tinyurl.com", "adf.ly", "clck.ru"}:
                    return 0.5
                else:
                    return 0.4
        
        return 0.0
    
    def check_legitimate_domain(self, url: str) -> bool:
        """Check if URL is from legitimate messenger domain."""
        parsed = urlparse(url)
        domain = parsed.netloc or parsed.path.split("/")[0]
        domain_lower = domain.lower()
        
        for legit_domain in self.legitimate_domains:
            if domain_lower == legit_domain or domain_lower.endswith("." + legit_domain):
                return True
        return False
    
    def check_domain_length(self, url: str) -> float:
        """Check if domain is suspiciously short (potential redirect domain)."""
        parsed = urlparse(url)
        domain = parsed.netloc or parsed.path.split("/")[0]
        
        # Very short domains (< 10 chars) are suspicious
        if len(domain) < 10:
            return 0.3
        elif len(domain) < 15:
            return 0.15
        
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
        """Check URLs in text for risk. Returns url_risk_score (0-1)."""
        urls = self.extract_urls(text)
        
        if not urls:
            return {
                "url_risk_score": 0.0,
                "url_count": 0,
                "has_short_domain": False,
                "has_risky_tld": False,
                "has_legitimate_domain": False
            }
        
        max_risk = 0.0
        total_risk = 0.0
        has_short = False
        has_risky = False
        has_legitimate = False
        
        for url in urls:
            # Check if legitimate (reduces risk)
            is_legitimate = self.check_legitimate_domain(url)
            if is_legitimate:
                has_legitimate = True
                # Legitimate domains get lower base risk, but still check context
                base_risk = 0.1
            else:
                base_risk = 0.0
            
            # TLD risk
            tld_risk = self.check_tld_risk(url)
            if tld_risk > 0:
                has_risky = True
            
            # Short domain risk
            short_risk = self.check_short_domain(url)
            if short_risk > 0:
                has_short = True
            
            # Domain length risk
            length_risk = self.check_domain_length(url)
            
            # Combine risks for this URL
            url_risk = base_risk + tld_risk + short_risk + length_risk
            
            # If it's a shortener, check final destination
            parsed = urlparse(url)
            domain = parsed.netloc or parsed.path.split("/")[0]
            if any(short in domain.lower() for short in self.short_domains):
                try:
                    final_url = await self.unpack_redirect(url)
                    if final_url and final_url != url:
                        final_tld_risk = self.check_tld_risk(final_url)
                        final_short_risk = self.check_short_domain(final_url)
                        final_length_risk = self.check_domain_length(final_url)
                        final_is_legit = self.check_legitimate_domain(final_url)
                        
                        if final_is_legit:
                            # Redirect to legitimate domain = lower risk
                            url_risk = min(url_risk, 0.3)
                        else:
                            # Redirect to risky domain = higher risk
                            url_risk = max(url_risk, final_tld_risk + final_short_risk + final_length_risk)
                except Exception:
                    pass  # If redirect check fails, use original URL risk
            
            # Track max risk and accumulate
            max_risk = max(max_risk, url_risk)
            total_risk += url_risk
        
        # Final score: weighted combination of max risk and average risk
        # Multiple URLs increase suspicion
        url_count_factor = min(1.0, 0.5 + (len(urls) - 1) * 0.15)
        final_score = max_risk * 0.7 + (total_risk / len(urls)) * 0.3 * url_count_factor
        
        # If legitimate domains found, reduce score slightly (but not completely)
        if has_legitimate and not has_risky and not has_short:
            final_score = final_score * 0.5
        
        return {
            "url_risk_score": min(final_score, 1.0),
            "url_count": len(urls),
            "has_short_domain": has_short,
            "has_risky_tld": has_risky,
            "has_legitimate_domain": has_legitimate
        }


lur = LinkURLRisk()

