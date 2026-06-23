from openai import AsyncOpenAI
from typing import Any, Dict, Optional
from app.config import settings
from app.metrics import metrics_collector
import logging
import json
import hashlib
from cachetools import TTLCache
import httpx
import asyncio
import time
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)


class LLMCheck:
    def __init__(self):
        api_key = settings.patas_openai_api_key or settings.openai_api_key
        self.enabled = bool(api_key)
        self._warmed_up = False
        self.client: Optional[AsyncOpenAI]
        
        if self.enabled:
            # Configure HTTP client with persistent connections and keep-alive
            http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(10.0, connect=5.0),
                limits=httpx.Limits(
                    max_keepalive_connections=10,
                    max_connections=20,
                    keepalive_expiry=30.0
                )
            )
            self.client = AsyncOpenAI(
                api_key=api_key,
                http_client=http_client,
                max_retries=2,
                timeout=10.0
            )
        else:
            self.client = None
        
        # Cache to avoid repeated LLM calls for same content (LRU + TTL)
        self.cache: TTLCache[str, Dict[str, Any]] = TTLCache(
            maxsize=getattr(settings, "llm_cache_size", 5000),
            ttl=getattr(settings, "llm_cache_ttl", 86400),
        )
        
        # Metrics tracking
        self.total_requests = 0
        self.cache_hits = 0
        self.tokens_saved = 0
        self.model = "gpt-4o-mini"

        # Circuit breaker state
        self._failures_consecutive = 0
        self._down_until: Optional[datetime] = None
        
        # Estimate tokens: ~4 chars per token
        self.avg_prompt_tokens = 50  # ~200 chars prompt
        self.avg_response_tokens = 20  # ~80 chars response

    def _cache_key(self, text: str) -> str:
        """Generate cache key from content hash."""
        normalized = text.strip().lower()
        return hashlib.md5(normalized.encode()).hexdigest()
    
    def _estimate_tokens(self, text: str) -> int:
        """Estimate token count (rough: ~4 chars per token)."""
        return len(text) // 4
    
    async def warmup(self) -> bool:
        """Warm-up connection: pre-auth + ping test."""
        if not self.enabled or not self.client:
            return False
        
        if self._warmed_up:
            return True
        
        try:
            # Lightweight test request to establish connection and verify auth
            await self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "test"}],
                max_tokens=5,
                temperature=0.0,
            )
            self._warmed_up = True
            logger.info("LLM connection warmed up successfully")
            return True
        except Exception as e:
            logger.warning(f"LLM warm-up failed: {e}")
            return False
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get cache metrics."""
        hit_rate = (self.cache_hits / self.total_requests * 100) if self.total_requests > 0 else 0.0
        down_remaining = 0.0
        is_down = False
        if self._down_until:
            now = datetime.now(timezone.utc)
            if now < self._down_until:
                is_down = True
                down_remaining = max(0.0, (self._down_until - now).total_seconds())
            else:
                self._down_until = None
                self._failures_consecutive = 0
                is_down = False
                down_remaining = 0.0
        # also mirror to global metrics
        try:
            metrics_collector.set_provider_health(
                provider='llm',
                up=not is_down,
                down_seconds_remaining=down_remaining,
                failures_consecutive=self._failures_consecutive
            )
        except Exception:
            pass
        return {
            "total_requests": self.total_requests,
            "cache_hits": self.cache_hits,
            "cache_misses": self.total_requests - self.cache_hits,
            "hit_rate": round(hit_rate, 2),
            "tokens_saved": self.tokens_saved,
            "cache_size": len(self.cache),
            "cache_max_size": self.cache.maxsize,
            "llm_request_rate": round((1 - hit_rate / 100) * 100, 2),  # % of requests that hit LLM
            "warmed_up": self._warmed_up,
            "provider_health": {
                "up": not is_down,
                "down_seconds_remaining": down_remaining,
                "failures_consecutive": self._failures_consecutive,
            }
        }

    async def check(
        self, 
        text: str, 
        byo_provider: Optional[str] = None,
        byo_api_key: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        # BYO mode: create temporary client
        client_to_use = self.client
        if byo_provider and byo_api_key:
            if byo_provider.lower() == "openai":
                http_client = httpx.AsyncClient(
                    timeout=httpx.Timeout(10.0, connect=5.0),
                    limits=httpx.Limits(
                        max_keepalive_connections=10,
                        max_connections=20,
                        keepalive_expiry=30.0
                    )
                )
                client_to_use = AsyncOpenAI(
                    api_key=byo_api_key,
                    http_client=http_client,
                    max_retries=2,
                    timeout=10.0
                )
            else:
                logger.warning(f"BYO provider {byo_provider} not yet supported, falling back to managed")
                return None
        elif not self.enabled or not self.client:
            return None
        else:
            client_to_use = self.client

        try:
            # Circuit breaker: short-circuit when provider is down
            if self._down_until:
                now = datetime.now(timezone.utc)
                if now < self._down_until:
                    logger.warning(f"LLM provider down, {int((self._down_until - now).total_seconds())}s remaining")
                    metrics_collector.set_provider_health('llm', up=False, down_seconds_remaining=(self._down_until - now).total_seconds(), failures_consecutive=self._failures_consecutive)
                    return None
                # window passed, reset
                self._down_until = None
                self._failures_consecutive = 0

            self.total_requests += 1
            key = self._cache_key(text)
            cached = self.cache.get(key)
            if cached is not None:
                # Cache hit - return cached result
                self.cache_hits += 1
                # Estimate tokens saved (prompt + response)
                tokens_estimate = self.avg_prompt_tokens + self.avg_response_tokens
                self.tokens_saved += tokens_estimate
                # Record cache hit in metrics
                metrics_collector.record_llm_request(
                    prompt_tokens=0,
                    completion_tokens=0,
                    model=self.model,
                    cached=True
                )
                return cached

            # Truncate text to essential content (first 500 chars should be enough)
            text_truncated = text[:500].strip()
            
            # Minimal prompt - only essential context
            prompt = f'Is this commercial spam? "{text_truncated}"'

            # Retry logic with exponential backoff (0.5s, 1.0s, 2.0s)
            max_retries = 3
            backoff_delays = [0.5, 1.0, 2.0]
            retry_count = 0
            start_time = time.time()
            last_error = None
            response = None
            
            for attempt in range(max_retries):
                try:
                    response = await client_to_use.chat.completions.create(
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
                    # Success - break out of retry loop
                    if retry_count > 0:
                        total_time = time.time() - start_time
                        logger.info(f"LLM request succeeded after {retry_count} retries, total time: {total_time:.2f}s")
                    break
                except Exception as e:
                    retry_count += 1
                    last_error = e
                    
                    if attempt < max_retries - 1:
                        # Wait before retry (exponential backoff)
                        delay = backoff_delays[attempt]
                        logger.warning(f"LLM request failed (attempt {attempt + 1}/{max_retries}): {e}. Retrying in {delay}s...")
                        await asyncio.sleep(delay)
                    else:
                        # All retries exhausted
                        total_time = time.time() - start_time
                        logger.error(f"LLM request failed after {max_retries} attempts, total time: {total_time:.2f}s. Last error: {last_error}")
                        # Count a failure event for circuit breaker and possibly trip it
                        self._failures_consecutive += 1
                        if self._failures_consecutive >= 3:
                            self._down_until = datetime.now(timezone.utc) + timedelta(seconds=120)
                            logger.error("LLM provider marked DOWN for 120s due to consecutive failures")
                            metrics_collector.set_provider_health('llm', up=False, down_seconds_remaining=120.0, failures_consecutive=self._failures_consecutive)
                        else:
                            metrics_collector.set_provider_health('llm', up=True, down_seconds_remaining=0.0, failures_consecutive=self._failures_consecutive)
                        # Return None to trigger rules-only fallback in pipeline
                        return None
            
            # If we get here, response was successful
            if not response:
                return None

            content = response.choices[0].message.content
            if not content:
                return None

            # Extract token usage from response
            prompt_tokens = response.usage.prompt_tokens if response.usage else self.avg_prompt_tokens
            completion_tokens = response.usage.completion_tokens if response.usage else self.avg_response_tokens

            # With response_format="json_object", content should be valid JSON
            try:
                parsed = json.loads(content)
                
                # Store in cache with metadata
                prompt_hash = hashlib.md5(prompt.encode()).hexdigest()
                result = {
                    "spam": 1.0 if parsed.get("is_spam") else 0.0,
                    "confidence": max(0.0, min(1.0, parsed.get("confidence", 0.5))),
                    "reasons": parsed.get("reasons", [])[:2],  # Limit to 2 reasons
                    "prompt_hash": prompt_hash,
                    "model": self.model,
                    "response": content[:100],  # Store first 100 chars of response
                }
                self.cache[key] = result
                
                # Record LLM request in metrics (with actual token usage)
                metrics_collector.record_llm_request(
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    model=self.model,
                    cached=False
                )
                
                # success: reset circuit breaker
                self._failures_consecutive = 0
                self._down_until = None
                metrics_collector.set_provider_health('llm', up=True, down_seconds_remaining=0.0, failures_consecutive=0)
                return result
            except json.JSONDecodeError:
                # Fallback: try to extract JSON if response_format didn't work
                json_start = content.find("{")
                json_end = content.rfind("}") + 1
                if json_start >= 0 and json_end > json_start:
                    json_str = content[json_start:json_end]
                    parsed = json.loads(json_str)
                    prompt_hash = hashlib.md5(prompt.encode()).hexdigest()
                    result = {
                        "spam": 1.0 if parsed.get("is_spam") else 0.0,
                        "confidence": max(0.0, min(1.0, parsed.get("confidence", 0.5))),
                        "reasons": parsed.get("reasons", [])[:2],
                        "prompt_hash": prompt_hash,
                        "model": self.model,
                        "response": content[:100],
                    }
                    self.cache[key] = result
                    
                    # Record LLM request (estimate tokens if not available)
                    prompt_tokens = response.usage.prompt_tokens if response.usage else self.avg_prompt_tokens
                    completion_tokens = response.usage.completion_tokens if response.usage else self.avg_response_tokens
                    metrics_collector.record_llm_request(
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        model=self.model,
                        cached=False
                    )
                    
                    # success: reset circuit breaker
                    self._failures_consecutive = 0
                    self._down_until = None
                    metrics_collector.set_provider_health('llm', up=True, down_seconds_remaining=0.0, failures_consecutive=0)
                    return result
                return None
        except Exception:
            # Log full stacktrace but do not crash callers
            logger.exception("LLM check failed (unexpected error)")
            # Count as failure event and maybe trip breaker
            self._failures_consecutive += 1
            if self._failures_consecutive >= 3:
                self._down_until = datetime.now(timezone.utc) + timedelta(seconds=120)
                logger.error("LLM provider marked DOWN for 120s due to consecutive failures")
                metrics_collector.set_provider_health('llm', up=False, down_seconds_remaining=120.0, failures_consecutive=self._failures_consecutive)
            else:
                metrics_collector.set_provider_health('llm', up=True, down_seconds_remaining=0.0, failures_consecutive=self._failures_consecutive)
            # Return None to trigger rules-only fallback in pipeline
            return None


llm_check = LLMCheck()
