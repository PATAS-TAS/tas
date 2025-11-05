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
            Dict with keys:
            - is_spam (bool): True if classified as spam
            - confidence (float): Confidence score (0.0-1.0)
            - reason (str): Main reason for classification
        
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

