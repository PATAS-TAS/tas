from typing import Dict, List, Optional
from app.regex_patterns import regex_patterns
from app.llm_check import llm_check
from app.config import settings
from app.cache import ClassificationCache
from app.rrs import rrs
from app.lur import lur
from app.sig import sig
from app.rol import rol
from app.qzn import qzn

cache = ClassificationCache(max_size=settings.cache_size, ttl=settings.cache_ttl)
import logging

logger = logging.getLogger(__name__)


class MultiLayerPipeline:
    def __init__(self):
        self.version = "1.0.3"
        self._rules_loaded = False

    async def _ensure_rules_loaded(self):
        """Ensure PATAS rules are loaded (if enabled)."""
        if settings.enable_rol and not self._rules_loaded:
            try:
                await rol.load_rules_from_patas(settings.patas_url, settings.patas_api_key or None)
                self._rules_loaded = True
            except Exception as e:
                logger.warning(f"Failed to load rules from PATAS: {e}")

    async def classify(self, text: str, lang: str = "en", sender_id: Optional[str] = None, message_id: Optional[str] = None) -> Dict:
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

        await self._ensure_rules_loaded()

        layers_used = []
        final_score = 0.0
        final_confidence = 0.0
        all_reasons: List[str] = []
        module_scores = {}

        # RRS: Reputation & Rate Sentinel
        if settings.enable_rrs and sender_id:
            rrs_result = rrs.check(sender_id, text)
            layers_used.append("rrs")
            if rrs_result["combined_score"] > 0.3:
                module_scores["rrs"] = rrs_result["combined_score"]
                if rrs_result["is_burst"]:
                    all_reasons.append("Burst pattern detected")

        # LUR: Link & URL Risk
        if settings.enable_lur:
            lur_result = await lur.check(text)
            if lur_result["url_count"] > 0:
                layers_used.append("lur")
            url_risk = lur_result["url_risk_score"]
            if url_risk > 0.3:
                # Use URL risk score directly (already 0-1)
                module_scores["lur"] = url_risk
                if lur_result["has_risky_tld"]:
                    all_reasons.append("Risky TLD detected")
                if lur_result["has_short_domain"]:
                    all_reasons.append("Short URL domain")
                if lur_result.get("has_legitimate_domain") and url_risk < 0.5:
                    # Legitimate domains with low risk - reduce impact
                    module_scores["lur"] = url_risk * 0.6

        # SIG: Signatures (fast check, no async needed)
        if settings.enable_sig:
            sig_result = sig.check(text)
            layers_used.append("sig")
            if sig_result.get("signature_score", 0.0) > 0.3:
                module_scores["sig"] = sig_result["signature_score"]
                if sig_result.get("signature_match", False):
                    all_reasons.append("Matches known spam signature")

        rule_results = regex_patterns.check(text)
        if rule_results:
            rule_score = max(score for _, score in rule_results)
            if len(rule_results) > 1:
                boost = 0.1 * (len(rule_results) - 1)
                rule_score = min(rule_score + boost, 0.95)
            commercial_keywords = ["Commercial trade offer", "Car sale offer", "Real estate offer", 
                                  "Job offer or work solicitation", "Service offer"]
            commercial_count = sum(1 for reason, _ in rule_results if reason in commercial_keywords)
            if commercial_count >= 1:
                word_count = len(text.split())
                text_lower = text.lower()
                
                # Check for negative context (not a spam offer)
                negative_context = any([
                    "в прошлом" in text_lower,
                    "в прошлом году" in text_lower,
                    "каждый день" in text_lower,
                    "в магазине" in text_lower,
                    "свой" in text_lower,
                    "старый" in text_lower,
                    "ищу работу" in text_lower,
                    "работаю" in text_lower,
                    "работаем" in text_lower,
                ])
                
                if not negative_context:
                    if word_count <= 5:
                        rule_score = min(rule_score + 0.1, 0.95)
                    if ("работа на дому" in text_lower or "работа удаленно" in text_lower or 
                        "work from home" in text_lower) and word_count <= 8:
                        rule_score = min(rule_score + 0.1, 0.95)
        else:
            rule_score = 0.0
        rule_reasons = [reason for reason, _ in rule_results[:3]]

        # Combine module scores with rule score
        combined_module_score = max(module_scores.values()) if module_scores else 0.0
        if module_scores:
            rule_score = max(rule_score, combined_module_score * 0.7)
        
        if rule_score >= settings.rules_threshold:
            final_score = rule_score
            final_confidence = rule_score
            all_reasons.extend(rule_reasons)
            layers_used.append("rules")
            
            # QZN: Quarantine
            if settings.enable_qzn and message_id:
                qzn_result = qzn.check(message_id, text, final_score)
                if qzn_result["is_quarantined"]:
                    all_reasons.append("Message quarantined")
            
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
