from openai import AsyncOpenAI
from typing import Dict, Optional
from app.config import settings
import logging
import json
import hashlib
from cachetools import TTLCache

logger = logging.getLogger(__name__)


class LLMCheck:
    def __init__(self):
        api_key = settings.patas_openai_api_key or settings.openai_api_key
        self.enabled = bool(api_key)
        if self.enabled:
            self.client = AsyncOpenAI(api_key=api_key)
        else:
            self.client = None
        # Cache to avoid repeated LLM calls for same content
        self.cache: TTLCache[str, Dict] = TTLCache(
            maxsize=getattr(settings, "llm_cache_size", 5000),
            ttl=getattr(settings, "llm_cache_ttl", 86400),
        )

    def _cache_key(self, text: str) -> str:
        return hashlib.md5(text.strip().lower().encode()).hexdigest()

    async def check(self, text: str) -> Optional[Dict[str, float]]:
        if not self.enabled or not self.client:
            return None

        try:
            key = self._cache_key(text)
            cached = self.cache.get(key)
            if cached is not None:
                return cached

            # Truncate text to essential content (first 500 chars should be enough)
            text_truncated = text[:500].strip()
            
            # Minimal prompt - only essential context
            prompt = f'Is this commercial spam? "{text_truncated}"'

            response = await self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": "Detect commercial spam. Return JSON only.",
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.0,
                top_p=1.0,
                max_tokens=80,
                response_format={"type": "json_object"},
            )

            content = response.choices[0].message.content
            if not content:
                return None

            # With response_format="json_object", content should be valid JSON
            try:
                parsed = json.loads(content)
                result = {
                    "spam": 1.0 if parsed.get("is_spam") else 0.0,
                    "confidence": max(0.0, min(1.0, parsed.get("confidence", 0.5))),
                    "reasons": parsed.get("reasons", [])[:2],  # Limit to 2 reasons
                }
                self.cache[key] = result
                return result
            except json.JSONDecodeError:
                # Fallback: try to extract JSON if response_format didn't work
                json_start = content.find("{")
                json_end = content.rfind("}") + 1
                if json_start >= 0 and json_end > json_start:
                    json_str = content[json_start:json_end]
                    parsed = json.loads(json_str)
                    result = {
                        "spam": 1.0 if parsed.get("is_spam") else 0.0,
                        "confidence": max(0.0, min(1.0, parsed.get("confidence", 0.5))),
                        "reasons": parsed.get("reasons", [])[:2],
                    }
                    self.cache[key] = result
                    return result
                return None
        except Exception as e:
            logger.error(f"LLM check error: {e}")
            return None


llm_check = LLMCheck()

