"""
Multi-layer spam classification pipeline.

This module implements a rules-first, LLM-assist approach to spam detection.
85% of requests are handled by fast rules, only 15% need LLM fallback.
"""
from typing import Dict, List, Optional, Any, Tuple
import asyncio
import hashlib
import logging
import time

from app.regex_patterns import regex_patterns
from app.llm_check import llm_check
from app.vision_check import vision_check
from app.config import settings
from app.cache import ClassificationCache
from app.rrs import rrs
from app.lur import lur
from app.sig import sig
from app.rol import rol
from app.qzn import qzn
from app.metrics import metrics_collector
from app.constants import (
    MODULE_SCORE_THRESHOLD,
    MULTI_PATTERN_BOOST,
    MAX_RULE_SCORE,
    EARLY_EXIT_SCORE_THRESHOLD,
    LLM_SPAM_THRESHOLD,
    LLM_LOW_CONFIDENCE_WEIGHT,
    VISION_SCORE_WEIGHT,
    VISION_RULE_WEIGHT,
    MAX_RESPONSE_REASONS,
    MAX_LLM_REASONS,
    COMMERCIAL_KEYWORDS,
    NEGATIVE_CONTEXT_PHRASES,
    API_VERSION,
)

cache = ClassificationCache(max_size=settings.cache_size, ttl=settings.cache_ttl)
logger = logging.getLogger(__name__)


class MultiLayerPipeline:
    """
    Multi-layer spam classification pipeline.

    Uses a rules-first approach with LLM fallback for uncertain cases.
    Supports parallel execution of independent modules for optimal latency.

    Attributes:
        version: API version string
    """

    def __init__(self) -> None:
        """Initialize the pipeline."""
        self.version = API_VERSION
        self._rules_loaded = False

    async def _ensure_rules_loaded(self) -> None:
        """Ensure PATAS rules are loaded (if enabled)."""
        if settings.enable_rol and not self._rules_loaded:
            try:
                await rol.load_rules_from_patas(
                    settings.patas_url, settings.patas_api_key or None
                )
                self._rules_loaded = True
            except Exception as e:
                logger.warning(f"Failed to load rules from PATAS: {e}")

    async def _check_modules_parallel(
        self, text: str, sender_id: Optional[str]
    ) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        """
        Run RRS, LUR, and SIG modules in parallel.

        Args:
            text: Text to check
            sender_id: Optional sender identifier

        Returns:
            Tuple of (rrs_result, lur_result, sig_result)
        """
        async def check_rrs() -> Optional[Dict[str, Any]]:
            if settings.enable_rrs and sender_id:
                return rrs.check(sender_id, text)
            return None

        async def check_lur() -> Optional[Dict[str, Any]]:
            if settings.enable_lur:
                return await lur.check(text)
            return None

        async def check_sig() -> Optional[Dict[str, Any]]:
            if settings.enable_sig:
                return sig.check(text)
            return None

        results = await asyncio.gather(
            check_rrs(),
            check_lur(),
            check_sig(),
            return_exceptions=True
        )

        rrs_result = results[0] if not isinstance(results[0], Exception) else None
        lur_result = results[1] if not isinstance(results[1], Exception) else None
        sig_result = results[2] if not isinstance(results[2], Exception) else None

        # Log exceptions
        if isinstance(results[0], Exception):
            logger.exception("RRS module error", exc_info=results[0])
        if isinstance(results[1], Exception):
            logger.exception("LUR module error", exc_info=results[1])
        if isinstance(results[2], Exception):
            logger.exception("SIG module error", exc_info=results[2])

        return rrs_result, lur_result, sig_result

    def _process_module_results(
        self,
        rrs_result: Optional[Dict[str, Any]],
        lur_result: Optional[Dict[str, Any]],
        sig_result: Optional[Dict[str, Any]],
    ) -> Tuple[List[str], Dict[str, float], List[str]]:
        """
        Process results from parallel modules.

        Args:
            rrs_result: Result from RRS module
            lur_result: Result from LUR module
            sig_result: Result from SIG module

        Returns:
            Tuple of (layers_used, module_scores, all_reasons)
        """
        layers_used: List[str] = []
        module_scores: Dict[str, float] = {}
        all_reasons: List[str] = []

        # Process RRS results
        if rrs_result:
            layers_used.append("rrs")
            if rrs_result["combined_score"] > MODULE_SCORE_THRESHOLD:
                module_scores["rrs"] = rrs_result["combined_score"]
                if rrs_result["is_burst"]:
                    all_reasons.append("Burst pattern detected")

        # Process LUR results
        if lur_result:
            if lur_result["url_count"] > 0:
                layers_used.append("lur")
            url_risk = lur_result["url_risk_score"]
            if url_risk > MODULE_SCORE_THRESHOLD:
                module_scores["lur"] = url_risk
                if lur_result["has_risky_tld"]:
                    all_reasons.append("Risky TLD detected")
                if lur_result["has_short_domain"]:
                    all_reasons.append("Short URL domain")
                if lur_result.get("has_legitimate_domain") and url_risk < 0.5:
                    module_scores["lur"] = url_risk * 0.6

        # Process SIG results
        if sig_result:
            layers_used.append("sig")
            if sig_result.get("signature_score", 0.0) > MODULE_SCORE_THRESHOLD:
                module_scores["sig"] = sig_result["signature_score"]
                if sig_result.get("signature_match", False):
                    all_reasons.append("Matches known spam signature")

        return layers_used, module_scores, all_reasons

    def _check_shadow_rules(
        self, text: str, message_id: Optional[str], sender_id: Optional[str]
    ) -> None:
        """
        Check shadow rules for logging only (no blocking).

        Args:
            text: Text to check
            message_id: Optional message identifier
            sender_id: Optional sender identifier
        """
        if not settings.enable_rol:
            return

        request_id = message_id or sender_id or text[:20]
        if rol.shadow_patterns and rol.should_use_shadow(request_id):
            shadow_results = rol.check_shadow_rules(text)
            if shadow_results:
                for reason, score in shadow_results:
                    rule_id = hashlib.md5(reason.encode()).hexdigest()[:8]
                    logger.info(
                        f"Shadow rule match: rule_id={rule_id}, reason={reason}, "
                        f"score={score:.2f}, text_preview={text[:50]}"
                    )

    def _calculate_rule_score(
        self,
        text: str,
        rule_results: List[Tuple[str, float]],
    ) -> Tuple[float, List[str]]:
        """
        Calculate combined rule score with context-aware adjustments.

        Args:
            text: Original text
            rule_results: List of (reason, score) tuples from regex patterns

        Returns:
            Tuple of (rule_score, rule_reasons)
        """
        if not rule_results:
            return 0.0, []

        rule_score = max(score for _, score in rule_results)

        # Boost for multiple matches
        if len(rule_results) > 1:
            boost = MULTI_PATTERN_BOOST * (len(rule_results) - 1)
            rule_score = min(rule_score + boost, MAX_RULE_SCORE)

        # Check for commercial keywords
        commercial_count = sum(
            1 for reason, _ in rule_results if reason in COMMERCIAL_KEYWORDS
        )

        if commercial_count >= 1:
            word_count = len(text.split())
            text_lower = text.lower()

            # Check for negative context (not a spam offer)
            # Use generator expression for short-circuiting
            negative_context = any(
                phrase in text_lower for phrase in NEGATIVE_CONTEXT_PHRASES
            )

            if not negative_context:
                if word_count <= 5:
                    rule_score = min(rule_score + 0.1, MAX_RULE_SCORE)
                if (
                    ("работа на дому" in text_lower or "работа удаленно" in text_lower or
                     "work from home" in text_lower) and word_count <= 8
                ):
                    rule_score = min(rule_score + 0.1, MAX_RULE_SCORE)

        rule_reasons = [reason for reason, _ in rule_results[:3]]
        return rule_score, rule_reasons

    async def _check_vision(
        self,
        image_path: Optional[str],
        image_bytes: Optional[bytes],
        image_url: Optional[str],
        current_score: float,
        all_reasons: List[str],
        layers_used: List[str],
    ) -> float:
        """
        Check image with vision model if provided.

        Args:
            image_path: Optional path to image file
            image_bytes: Optional image bytes
            image_url: Optional URL to image
            current_score: Current rule score
            all_reasons: List to append reasons to
            layers_used: List to append layers to

        Returns:
            Updated score
        """
        if not settings.vision_enabled:
            return current_score

        if not (image_path or image_bytes or image_url):
            return current_score

        try:
            vision_result = await vision_check.check_image(
                image_path=image_path,
                image_bytes=image_bytes,
                image_url=image_url
            )
            if vision_result:
                vision_score = vision_result.get("spam_score", 0.0)
                vision_reasons = vision_result.get("reasons", [])
                detected_text = vision_result.get("detected_text", "")

                if vision_score > 0.5:
                    current_score = max(current_score, vision_score * VISION_SCORE_WEIGHT)
                    all_reasons.extend([f"Vision: {r}" for r in vision_reasons[:2]])
                    layers_used.append("vision")

                    # If vision found text, also check it with rules
                    if detected_text and len(detected_text) > 10:
                        vision_rule_results = regex_patterns.check(detected_text)
                        if vision_rule_results:
                            vision_rule_score = max(
                                score for _, score in vision_rule_results
                            )
                            current_score = max(
                                current_score, vision_rule_score * VISION_RULE_WEIGHT
                            )
        except Exception:
            logger.exception("Vision check error, continuing without vision")

        return current_score

    async def _check_llm(
        self,
        text: str,
        llm_mode: str,
        byo_provider: Optional[str],
        byo_api_key: Optional[str],
        current_score: float,
    ) -> Tuple[float, float, List[str], str, bool]:
        """
        Check text with LLM if needed.

        Args:
            text: Text to check
            llm_mode: LLM mode (managed, byo, rules_only)
            byo_provider: BYO provider name
            byo_api_key: BYO API key
            current_score: Current rule score

        Returns:
            Tuple of (final_score, confidence, reasons, mode_used, llm_was_called)
        """
        llm_mode_used = llm_mode
        all_reasons: List[str] = []

        if llm_mode == "rules_only":
            return current_score, current_score, [], llm_mode_used, False

        llm_result = None

        if llm_mode == "byo" and byo_provider and byo_api_key:
            try:
                llm_result = await llm_check.check(
                    text, byo_provider=byo_provider, byo_api_key=byo_api_key
                )
            except Exception:
                logger.exception("BYO LLM error, falling back to rules-only")
                llm_mode_used = "rules_only"
        elif settings.llm_fallback and current_score < settings.rules_threshold:
            try:
                llm_result = await llm_check.check(text)
            except Exception:
                logger.exception("LLM fallback error")

        if llm_result:
            llm_spam = llm_result.get("spam", 0.0)
            llm_confidence = llm_result.get("confidence", 0.0)
            llm_reasons = llm_result.get("reasons", [])

            if llm_spam > LLM_SPAM_THRESHOLD:
                final_score = llm_spam
                final_confidence = llm_confidence
                all_reasons.extend(llm_reasons[:MAX_LLM_REASONS])
            else:
                final_score = max(current_score, llm_spam * LLM_LOW_CONFIDENCE_WEIGHT)
                final_confidence = (current_score + llm_confidence) / 2
                if llm_reasons:
                    all_reasons.extend(llm_reasons[:MAX_LLM_REASONS])

            return final_score, final_confidence, all_reasons, llm_mode_used, True
        elif llm_mode != "rules_only":
            logger.info("LLM unavailable after retries, using rules-only classification")

        return current_score, current_score, [], llm_mode_used, False

    def _format_result(
        self,
        score: float,
        confidence: float,
        reasons: List[str],
        layers_used: List[str],
    ) -> Dict[str, Any]:
        """
        Format classification result.

        Args:
            score: Spam score (0.0-1.0)
            confidence: Confidence score (0.0-1.0)
            reasons: List of reason strings
            layers_used: List of layer names used

        Returns:
            Formatted result dictionary
        """
        return {
            "spam_score": round(score, 3),
            "confidence": round(confidence, 3),
            "reasons": reasons[:MAX_RESPONSE_REASONS],
            "layers_used": layers_used,
            "version": self.version,
        }

    async def classify(
        self,
        text: str,
        lang: str = "en",
        sender_id: Optional[str] = None,
        message_id: Optional[str] = None,
        llm_mode: str = "managed",
        byo_provider: Optional[str] = None,
        byo_api_key: Optional[str] = None,
        image_path: Optional[str] = None,
        image_bytes: Optional[bytes] = None,
        image_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Classify text for spam using multi-layer pipeline.

        Args:
            text: Text to classify
            lang: Language code (default: "en")
            sender_id: Optional sender identifier for reputation tracking
            message_id: Optional message identifier
            llm_mode: LLM mode - "managed", "byo", or "rules_only"
            byo_provider: BYO provider name (e.g., "openai")
            byo_api_key: BYO API key
            image_path: Optional path to image file for vision analysis
            image_bytes: Optional image bytes for vision analysis
            image_url: Optional URL to image for vision analysis

        Returns:
            Classification result with spam_score, confidence, reasons, layers_used
        """
        start_time = time.time()

        # Pre-check: handle empty text
        try:
            text = text.strip()
            if not text:
                result = self._format_result(0.0, 0.0, [], [])
                latency = time.time() - start_time
                metrics_collector.record_request(latency, False)
                return result
        except Exception:
            logger.exception("Pipeline pre-check failed")
            latency = time.time() - start_time
            metrics_collector.record_request(latency, False)
            return self._format_result(0.0, 0.0, ["module_error"], [])

        # Check cache
        cached = cache.get(text, lang)
        if cached:
            cached["cached"] = True
            latency = time.time() - start_time
            is_spam = cached.get("spam_score", 0.0) >= settings.decision_threshold
            metrics_collector.record_request(latency, is_spam)
            return cached

        await self._ensure_rules_loaded()

        # Run parallel module checks
        rrs_result, lur_result, sig_result = await self._check_modules_parallel(
            text, sender_id
        )
        layers_used, module_scores, all_reasons = self._process_module_results(
            rrs_result, lur_result, sig_result
        )

        # Check shadow rules (logging only)
        self._check_shadow_rules(text, message_id, sender_id)

        # Calculate rule score
        rule_results = regex_patterns.check(text)
        rule_score, rule_reasons = self._calculate_rule_score(text, rule_results)

        # Combine module scores with rule score
        combined_module_score = max(module_scores.values()) if module_scores else 0.0
        if module_scores:
            rule_score = max(rule_score, combined_module_score * 0.7)

        # Early exit if rules are confident
        if rule_score >= settings.rules_threshold:
            all_reasons.extend(rule_reasons)
            layers_used.append("rules")

            # QZN: Quarantine
            if settings.enable_qzn and message_id:
                qzn_result = qzn.check(message_id, text, rule_score)
                if qzn_result["is_quarantined"]:
                    all_reasons.append("Message quarantined")

            result = self._format_result(rule_score, rule_score, all_reasons, layers_used)
            cache.set(text, result, lang)
            latency = time.time() - start_time
            is_spam = rule_score >= settings.decision_threshold
            metrics_collector.record_request(latency, is_spam)
            return result

        layers_used.append("rules")

        # Vision check
        rule_score = await self._check_vision(
            image_path, image_bytes, image_url,
            rule_score, all_reasons, layers_used
        )

        # Early exit if high confidence from rules + vision
        if rule_score >= EARLY_EXIT_SCORE_THRESHOLD:
            all_reasons.extend(rule_reasons)
            result = self._format_result(rule_score, rule_score, all_reasons, layers_used)
            cache.set(text, result, lang)
            latency = time.time() - start_time
            is_spam = rule_score >= settings.decision_threshold
            metrics_collector.record_request(latency, is_spam)
            return result

        # LLM check
        final_score, final_confidence, llm_reasons, llm_mode_used, llm_called = (
            await self._check_llm(text, llm_mode, byo_provider, byo_api_key, rule_score)
        )

        if llm_called:
            all_reasons.extend(llm_reasons)
            layers_used.append("llm")
        else:
            final_score = rule_score
            final_confidence = rule_score

        all_reasons.extend(rule_reasons)
        result = self._format_result(final_score, final_confidence, all_reasons, layers_used)
        result["llm_mode"] = llm_mode_used
        cache.set(text, result, lang)
        latency = time.time() - start_time
        is_spam = final_score >= settings.decision_threshold
        metrics_collector.record_request(latency, is_spam)
        return result


pipeline = MultiLayerPipeline()
