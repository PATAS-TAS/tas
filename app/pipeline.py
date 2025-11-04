from typing import Dict, List
from app.regex_patterns import regex_patterns
from app.llm_check import llm_check
from app.config import settings
from app.cache import ClassificationCache

cache = ClassificationCache(max_size=settings.cache_size, ttl=settings.cache_ttl)
import logging

logger = logging.getLogger(__name__)


class MultiLayerPipeline:
    def __init__(self):
        self.version = "1.0.2"

    async def classify(self, text: str, lang: str = "en") -> Dict:
        text = text.strip()
        if not text:
            return {
                "spam_score": 0.0,
                "confidence": 0.0,
                "reasons": [],
                "layers_used": [],
                "version": self.version,
            }
        
        cached = cache.get(text, lang)
        if cached:
            cached["cached"] = True
            return cached

        layers_used = []
        final_score = 0.0
        final_confidence = 0.0
        all_reasons: List[str] = []

        rule_results = regex_patterns.check(text)
        if rule_results:
            rule_score = max(score for _, score in rule_results)
            if len(rule_results) > 1:
                rule_score = min(rule_score + 0.1 * (len(rule_results) - 1), 0.95)
        else:
            rule_score = 0.0
        rule_reasons = [reason for reason, _ in rule_results[:3]]

        if rule_score >= settings.rules_threshold:
            final_score = rule_score
            final_confidence = rule_score
            all_reasons.extend(rule_reasons)
            layers_used.append("rules")
            result = self._format_result(final_score, final_confidence, all_reasons, layers_used)
            cache.set(text, result, lang)
            return result

        layers_used.append("rules")

        if settings.llm_fallback and final_score < settings.rules_threshold:
            llm_result = await llm_check.check(text)
            if llm_result:
                llm_spam = llm_result.get("spam", 0.0)
                llm_confidence = llm_result.get("confidence", 0.0)
                llm_reasons = llm_result.get("reasons", [])

                if llm_spam > 0.5:
                    final_score = llm_spam
                    final_confidence = llm_confidence
                    all_reasons.extend(llm_reasons)
                else:
                    final_score = max(final_score, llm_spam * 0.3)
                    final_confidence = (final_confidence + llm_confidence) / 2
                    if llm_reasons:
                        all_reasons.extend(llm_reasons[:2])

                layers_used.append("llm")
        else:
            final_score = rule_score
            final_confidence = rule_score

        result = self._format_result(final_score, final_confidence, all_reasons, layers_used)
        cache.set(text, result, lang)
        return result

    def _format_result(self, score: float, confidence: float, reasons: List[str], layers_used: List[str]) -> Dict:
        return {
            "spam_score": round(score, 3),
            "confidence": round(confidence, 3),
            "reasons": reasons[:5],
            "layers_used": layers_used,
            "version": self.version,
        }


pipeline = MultiLayerPipeline()
