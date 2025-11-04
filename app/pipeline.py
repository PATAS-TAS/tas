from typing import Dict, List
from app.regex_patterns import regex_patterns
from app.ml_model import ml_model
from app.llm_check import llm_check
from app.config import settings
from app.cache import ClassificationCache

# Initialize cache with settings
cache = ClassificationCache(max_size=settings.cache_size, ttl=settings.cache_ttl)
import logging

logger = logging.getLogger(__name__)


class MultiLayerPipeline:
    def __init__(self):
        self.version = "1.0.1"
        self.ml_model = ml_model

    async def classify(self, text: str, lang: str = "en") -> Dict:
        text = text.strip()
        if not text:
            return {
                "spam_score": 0.0,
                "confidence": 0.0,
                "labels": [],
                "reasons": [],
                "layers_used": [],
                "version": self.version,
            }
        
        # Check cache first
        cached = cache.get(text, lang)
        if cached:
            cached["cached"] = True
            return cached

        layers_used = []
        final_score = 0.0
        final_confidence = 0.0
        all_reasons: List[str] = []

        rule_results = regex_patterns.check(text)
        # Use maximum score instead of average for better detection
        if rule_results:
            rule_score = max(score for _, score in rule_results)
            # Boost if multiple patterns match
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
            return self._format_result(final_score, final_confidence, all_reasons, layers_used)

        layers_used.append("rules")

        if ml_model.model and ml_model.tokenizer:
            ml_results = ml_model.predict(text)
            ml_spam = ml_results.get("spam", 0.0)
            ml_confidence = ml_results.get("confidence", 0.0)

            if ml_spam >= settings.ml_threshold:
                final_score = ml_spam
                final_confidence = ml_confidence
                all_reasons.extend(rule_reasons)
                all_reasons.append("ML model detected spam")
                layers_used.append("ml")
                return self._format_result(final_score, final_confidence, all_reasons, layers_used)

            layers_used.append("ml")
            combined_score = 0.4 * rule_score + 0.6 * ml_spam
            combined_confidence = (rule_score + ml_confidence) / 2

            if combined_score >= settings.ml_threshold:
                final_score = combined_score
                final_confidence = combined_confidence
                all_reasons.extend(rule_reasons)
                all_reasons.append("ML model detected suspicious content")
                return self._format_result(final_score, final_confidence, all_reasons, layers_used)

            # Optimize LLM calls: if ML is very confident it's NOT spam, skip LLM
            if ml_spam < settings.ml_safe_threshold and ml_confidence > 0.8:
                final_score = combined_score
                final_confidence = combined_confidence
                all_reasons.extend(rule_reasons)
                all_reasons.append("ML model confident it's safe")
                return self._format_result(final_score, final_confidence, all_reasons, layers_used)

            final_score = combined_score
            final_confidence = combined_confidence
            all_reasons.extend(rule_reasons)

        if settings.llm_fallback and (final_score < settings.ml_threshold or not ml_model.model):
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

        result = self._format_result(final_score, final_confidence, all_reasons, layers_used)
        
        # Cache result
        cache.set(text, result, lang)
        
        return result

    def _detect_category(self, reasons: List[str]) -> str:
        """Detect spam category from reasons."""
        reason_text = " ".join(reasons).lower()
        
        if any(word in reason_text for word in ["job", "work", "vacancy", "работа", "вакансия", "заработок"]):
            return "job_offer"
        elif any(word in reason_text for word in ["trade", "buy", "sell", "куплю", "продам", "продаю"]):
            return "buy_sell"
        elif any(word in reason_text for word in ["car", "auto", "авто", "машина"]):
            return "car_sale"
        elif any(word in reason_text for word in ["real estate", "квартир", "дом", "недвижимость"]):
            return "real_estate"
        elif any(word in reason_text for word in ["service", "repair", "tutoring", "cleaning", "услуги", "ремонт"]):
            return "service"
        elif any(word in reason_text for word in ["scam", "click here", "urgent", "free money"]):
            return "scam"
        else:
            return "commercial_spam"
    
    def _format_result(self, score: float, confidence: float, reasons: List[str], layers_used: List[str]) -> Dict:
        return {
            "spam_score": round(score, 3),
            "confidence": round(confidence, 3),
            "reasons": reasons[:5],
            "layers_used": layers_used,
            "version": self.version,
        }


pipeline = MultiLayerPipeline()

