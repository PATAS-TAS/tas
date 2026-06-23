import hashlib
from typing import Any, Dict, List, Optional, Set
from cachetools import TTLCache
import logging

logger = logging.getLogger(__name__)


class Signatures:
    def __init__(self, max_size: int = 10000, ttl: int = 86400):
        self.signature_cache: TTLCache[str, Dict[str, Any]] = TTLCache(maxsize=max_size, ttl=ttl)
        self.known_spam_signatures: Set[str] = set()
        self.shingle_size = 3
        
    def generate_shingles(self, text: str, size: Optional[int] = None) -> List[str]:
        """Generate shingles (n-grams) from text."""
        if size is None:
            size = self.shingle_size
        
        words = text.lower().split()
        if len(words) < size:
            return [text.lower()]
        
        shingles = []
        for i in range(len(words) - size + 1):
            shingle = " ".join(words[i:i + size])
            shingles.append(shingle)
        
        return shingles
    
    def generate_signature(self, text: str) -> str:
        """Generate message signature from shingles."""
        shingles = self.generate_shingles(text)
        combined = "|".join(sorted(shingles))
        signature = hashlib.md5(combined.encode()).hexdigest()
        return signature
    
    def extract_key_words(self, text: str) -> List[str]:
        """Extract key words (commercial keywords) from text."""
        commercial_keywords = [
            "продам", "продаю", "куплю", "покупаю", "продажа", "покупка",
            "работа", "вакансия", "заработок", "job", "work", "sale", "buy",
            "звоните", "пишите", "call", "contact", "цена", "стоимость", "price"
        ]
        
        words = text.lower().split()
        key_words = [w for w in words if any(kw in w for kw in commercial_keywords)]
        return key_words[:5]
    
    def get_signature(self, text: str) -> Dict[str, Any]:
        """Get signature and metadata for message."""
        if text in self.signature_cache:
            return self.signature_cache[text]
        
        signature = self.generate_signature(text)
        shingles = self.generate_shingles(text)
        key_words = self.extract_key_words(text)
        
        result = {
            "signature": signature,
            "shingles": shingles,
            "shingle_count": len(shingles),
            "key_words": key_words,
            "word_count": len(text.split())
        }
        
        self.signature_cache[text] = result
        return result
    
    def check_against_known(self, text: str) -> Dict[str, Any]:
        """Check if message signature matches known spam signatures."""
        sig_data = self.get_signature(text)
        signature = sig_data["signature"]
        
        if signature in self.known_spam_signatures:
            return {
                "signature_match": True,
                "signature_score": 0.8,
                "matched_signature": signature
            }
        
        shingles = sig_data["shingles"]
        matching_shingles = sum(1 for shingle in shingles if self._check_shingle_match(shingle))
        
        if matching_shingles > 0:
            match_ratio = matching_shingles / max(len(shingles), 1)
            return {
                "signature_match": False,
                "signature_score": min(match_ratio * 0.6, 0.7),
                "shingle_matches": matching_shingles,
                "match_ratio": match_ratio
            }
        
        return {
            "signature_match": False,
            "signature_score": 0.0
        }
    
    def _check_shingle_match(self, shingle: str) -> bool:
        """Check if shingle matches known spam patterns."""
        spam_patterns = [
            "продам", "продаю", "куплю", "работа", "заработок",
            "звоните", "пишите", "цена", "стоимость"
        ]
        
        return any(pattern in shingle for pattern in spam_patterns)
    
    def add_spam_signature(self, text: str) -> None:
        """Add signature to known spam signatures."""
        sig_data = self.get_signature(text)
        signature = sig_data["signature"]
        self.known_spam_signatures.add(signature)
        logger.info(f"Added spam signature: {signature[:16]}...")
    
    def load_signatures_from_patas(self, signatures: List[str]) -> None:
        """Load known spam signatures from PATAS."""
        self.known_spam_signatures.update(signatures)
        logger.info(f"Loaded {len(signatures)} spam signatures from PATAS")
    
    def check(self, text: str) -> Dict[str, Any]:
        """Check message signature for spam indicators."""
        sig_data = self.get_signature(text)
        match_result = self.check_against_known(text)
        
        return {
            "signature": sig_data["signature"],
            "signature_score": match_result.get("signature_score", 0.0),
            "signature_match": match_result.get("signature_match", False),
            "key_words": sig_data["key_words"],
            "shingle_count": sig_data["shingle_count"]
        }


sig = Signatures()
