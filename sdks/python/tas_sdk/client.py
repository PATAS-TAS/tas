"""
TAS API Client for Python
"""
import requests
from typing import Optional, Dict, Any
import time


class TASClient:
    """Client for TAS (Transmodal Anti-Spam) API."""
    
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://tas.fly.dev",
        api_version: str = "v1"
    ):
        """
        Initialize TAS client.
        
        Args:
            api_key: Your RapidAPI API key or direct API key
            base_url: Base URL of TAS API (default: https://tas.fly.dev)
            api_version: API version to use (default: v1)
        """
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.api_version = api_version
        self.session = requests.Session()
        # Support both RapidAPI and direct API key formats
        if "x-api-key" in api_key.lower() or len(api_key) < 50:
            # Direct API key
            self.session.headers.update({
                "x-api-key": api_key,
                "Content-Type": "application/json"
            })
        else:
            # RapidAPI format
            self.session.headers.update({
                "X-RapidAPI-Key": api_key,
                "X-RapidAPI-Host": "tas.fly.dev",
                "Content-Type": "application/json"
            })
    
    def classify(
        self,
        text: str,
        lang: Optional[str] = "en",
        sender_id: Optional[str] = None,
        message_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Classify text as spam or not spam.
        
        Args:
            text: Text message to classify (1-8192 characters)
            lang: Language code (default: "en")
            sender_id: Optional sender identifier
            message_id: Optional message identifier
        
        Returns:
            Dict with keys (new schema):
            - spam (bool): True if classified as spam
            - score (float): Spam score (0.0-1.0)
            - reasons (list): List of reason objects with code, text, weight
            - path (str): Detection path ("rules" or "llm")
            - request_id (str): Unique request identifier
            - Legacy fields (deprecated): is_spam, confidence, reason
        
        Raises:
            requests.HTTPError: If API request fails
        """
        url = f"{self.base_url}/{self.api_version}/classify"
        
        payload = {
            "text": text,
            "lang": lang
        }
        
        if sender_id:
            payload["sender_id"] = sender_id
        if message_id:
            payload["message_id"] = message_id
        
        response = self.session.post(url, json=payload, timeout=10)
        response.raise_for_status()
        result = response.json()
        
        # Extract request_id from header if available
        if "X-TAS-Request-ID" in response.headers:
            result["request_id"] = response.headers["X-TAS-Request-ID"]
        
        return result
    
    def batch(
        self,
        texts: list,
        lang: Optional[str] = "en"
    ) -> list:
        """
        Batch classify multiple texts.
        
        Args:
            texts: List of text messages to classify (max 100, each ≤ 2000 chars)
            lang: Language code (default: "en")
        
        Returns:
            List of classification result dicts (same format as classify())
        
        Raises:
            requests.HTTPError: If API request fails or payload too large
        """
        url = f"{self.base_url}/{self.api_version}/batch"
        
        if len(texts) > 100:
            raise ValueError("Maximum 100 texts per batch request")
        
        payload = [
            {"text": text, "lang": lang}
            for text in texts
        ]
        
        response = self.session.post(url, json=payload, timeout=30)
        response.raise_for_status()
        return response.json()
    
    def health(self) -> Dict[str, Any]:
        """
        Check API health status.
        
        Returns:
            Dict with health status, version, and metrics
        """
        url = f"{self.base_url}/{self.api_version}/health"
        response = self.session.get(url, timeout=5)
        response.raise_for_status()
        return response.json()
    
    def version(self) -> Dict[str, Any]:
        """
        Get API version information.
        
        Returns:
            Dict with version and API version
        """
        url = f"{self.base_url}/{self.api_version}/version"
        response = self.session.get(url, timeout=5)
        response.raise_for_status()
        return response.json()


# Convenience function for quick usage
def classify_text(
    text: str,
    api_key: str,
    lang: Optional[str] = "en",
    base_url: str = "https://tas.fly.dev"
) -> Dict[str, Any]:
    """
    Quick function to classify text without creating a client.
    
    Args:
        text: Text to classify
        api_key: API key
        lang: Language code (default: "en")
        base_url: Base URL (default: https://tas.fly.dev)
    
    Returns:
        Classification result dict
    """
    client = TASClient(api_key=api_key, base_url=base_url)
    return client.classify(text=text, lang=lang)

