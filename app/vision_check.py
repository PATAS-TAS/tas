"""
Vision check module for transmodal spam detection.
Analyzes images for commercial spam text using OpenRouter vision models.
"""

import base64
import logging
from pathlib import Path
from typing import Optional, Dict, Any
from datetime import datetime, timezone
import httpx
from app.config import settings

logger = logging.getLogger(__name__)


class VisionCheck:
    """Check images for commercial spam using vision models via OpenRouter."""
    
    def __init__(self):
        self.enabled = settings.vision_enabled if hasattr(settings, 'vision_enabled') else False
        self.api_key = getattr(settings, 'openrouter_api_key', None)
        self.api_url = "https://openrouter.ai/api/v1/chat/completions"
        self.model = getattr(settings, 'vision_model', 'openai/gpt-4o-mini')
        self.timeout = 10.0
        self.max_retries = 2
        
        if not self.api_key:
            logger.warning("OpenRouter API key not set, vision check disabled")
            self.enabled = False
    
    def _encode_image(self, image_path: str) -> Optional[str]:
        """Encode image to base64."""
        try:
            with open(image_path, 'rb') as f:
                return base64.b64encode(f.read()).decode('utf-8')
        except Exception as e:
            logger.error(f"Failed to encode image {image_path}: {e}")
            return None
    
    def _encode_image_from_bytes(self, image_bytes: bytes) -> str:
        """Encode image bytes to base64."""
        return base64.b64encode(image_bytes).decode('utf-8')
    
    async def check_image(
        self,
        image_path: Optional[str] = None,
        image_bytes: Optional[bytes] = None,
        image_url: Optional[str] = None,
        image_base64: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Check image for commercial spam.
        
        Supports multiple input formats:
        - image_path: Local file path
        - image_bytes: Raw image bytes
        - image_url: URL to image (model fetches it)
        - image_base64: Base64-encoded image
        
        Returns dict with spam_score, is_spam, detected_text, reasons
        """
        if not self.enabled or not self.api_key:
            return None
        
        # Prepare image content
        image_content = None
        image_format = None
        
        if image_base64:
            image_content = image_base64
            image_format = "base64"
        elif image_bytes:
            image_content = self._encode_image_from_bytes(image_bytes)
            image_format = "base64"
        elif image_path:
            image_content = self._encode_image(image_path)
            if not image_content:
                return None
            image_format = "base64"
        elif image_url:
            image_content = image_url
            image_format = "url"
        else:
            logger.error("No image input provided")
            return None
        
        # Build prompt for commercial spam detection
        prompt = """Analyze this image for commercial spam. Look for:
1. Promotional text (discounts, sales, offers)
2. Contact information (phone, email, telegram handles)
3. URLs or links
4. Job offers or work solicitations
5. Commercial trade offers (buy/sell)
6. Cryptocurrency or investment scams
7. Referral/affiliate schemes

Respond in JSON format:
{
  "is_spam": true/false,
  "confidence": 0.0-1.0,
  "detected_text": "all text found in image",
  "reasons": ["reason1", "reason2"],
  "spam_indicators": ["indicator1", "indicator2"]
}"""
        
        # Build messages for vision model
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{image_content}" if image_format == "base64" else image_content
                        }
                    }
                ]
            }
        ]
        
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    self.api_url,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "HTTP-Referer": getattr(settings, 'app_url', 'https://tas.fly.dev'),
                        "X-Title": "TAS Anti-Spam",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": self.model,
                        "messages": messages,
                        "max_tokens": 500,
                        "temperature": 0.3
                    }
                )
                
                if response.status_code != 200:
                    logger.error(f"OpenRouter API error: {response.status_code} - {response.text}")
                    return None
                
                result = response.json()
                content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                
                # Parse JSON response
                import json
                try:
                    # Extract JSON from markdown code blocks if present
                    if "```json" in content:
                        content = content.split("```json")[1].split("```")[0].strip()
                    elif "```" in content:
                        content = content.split("```")[1].split("```")[0].strip()
                    
                    parsed = json.loads(content)
                    
                    spam_score = parsed.get("confidence", 0.0) if parsed.get("is_spam") else 0.0
                    
                    return {
                        "spam_score": spam_score,
                        "is_spam": parsed.get("is_spam", False),
                        "confidence": parsed.get("confidence", 0.0),
                        "detected_text": parsed.get("detected_text", ""),
                        "reasons": parsed.get("reasons", []),
                        "spam_indicators": parsed.get("spam_indicators", []),
                        "model": self.model,
                        "source": "vision"
                    }
                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse vision model response: {e}, content: {content[:200]}")
                    # Fallback: try to extract spam indicators from text
                    is_spam = any(keyword in content.lower() for keyword in [
                        "spam", "commercial", "promotion", "discount", "offer", "sale"
                    ])
                    return {
                        "spam_score": 0.7 if is_spam else 0.0,
                        "is_spam": is_spam,
                        "confidence": 0.5,
                        "detected_text": content[:500],
                        "reasons": ["vision_analysis_fallback"],
                        "spam_indicators": [],
                        "model": self.model,
                        "source": "vision"
                    }
        
        except Exception as e:
            logger.exception(f"Vision check failed: {e}")
            return None


# Global instance
vision_check = VisionCheck()

