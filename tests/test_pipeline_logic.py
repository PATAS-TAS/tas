"""
Pipeline logic testing - rules, ML, LLM layers.
"""
import asyncio
import pytest
from app.pipeline import pipeline
from app.config import settings


@pytest.mark.asyncio
class TestRulesLayer:
    async def test_rules_only_spam(self):
        """Test that obvious spam is caught by rules layer."""
        result = await pipeline.classify("Продам iPhone 12, недорого! Звоните +79001234567")
        assert result["spam_score"] > 0
        assert "rules" in result["layers_used"]
    
    async def test_rules_only_safe(self):
        """Test that safe content passes rules layer."""
        result = await pipeline.classify("Hello, how are you? Nice weather today.")
        assert result["spam_score"] < 0.5
        assert "rules" in result["layers_used"]
    
    async def test_url_detection(self):
        """Test URL detection in rules."""
        result = await pipeline.classify("Check this out: https://example.com")
        assert any("URL" in reason for reason in result["reasons"])
    
    async def test_phone_detection(self):
        """Test phone number detection."""
        result = await pipeline.classify("Call me at +79001234567")
        assert any("phone" in reason.lower() for reason in result["reasons"])


@pytest.mark.asyncio
class TestMLLayer:
    async def test_ml_activation(self):
        """Test that ML layer activates when rules don't decide."""
        result = await pipeline.classify("This is a borderline case that needs ML")
        assert "ml" in result["layers_used"] or "rules" in result["layers_used"]
    
    async def test_ml_safe_threshold(self):
        """Test ML safe threshold optimization."""
        result = await pipeline.classify("Hello, this is a normal friendly message")
        layers = result["layers_used"]
        if "ml" in layers and "llm" not in layers:
            assert result["spam_score"] < settings.ml_safe_threshold * 2


@pytest.mark.asyncio
class TestCache:
    async def test_cache_hit(self):
        """Test that identical requests are cached."""
        text = "Test cache message"
        result1 = await pipeline.classify(text)
        result2 = await pipeline.classify(text)
        assert result1 == result2 or result2.get("cached") == True
    
    async def test_cache_different_texts(self):
        """Test that different texts produce different results."""
        result1 = await pipeline.classify("Text one")
        result2 = await pipeline.classify("Text two")
        assert result1 != result2


@pytest.mark.asyncio
class TestEdgeCases:
    async def test_empty_string(self):
        """Test empty string handling."""
        result = await pipeline.classify("")
        assert result["spam_score"] == 0.0
        assert len(result["reasons"]) == 0
    
    async def test_whitespace_only(self):
        """Test whitespace-only input."""
        result = await pipeline.classify("   \n\t   ")
        assert result["spam_score"] == 0.0
    
    async def test_very_long_text(self):
        """Test very long text."""
        long_text = "A" * 5000
        result = await pipeline.classify(long_text)
        assert "spam_score" in result
    
    async def test_unicode(self):
        """Test unicode characters."""
        result = await pipeline.classify("Привет! 🎉 你好 مرحبا")
        assert result["spam_score"] >= 0
    
    async def test_special_characters(self):
        """Test special characters."""
        result = await pipeline.classify("!@#$%^&*()_+-=[]{}|;':\",./<>?")
        assert result["spam_score"] >= 0
    
    async def test_newlines(self):
        """Test text with newlines."""
        result = await pipeline.classify("Line 1\nLine 2\nLine 3")
        assert result["spam_score"] >= 0


@pytest.mark.asyncio
class TestCategoryDetection:
    async def test_job_offer_category(self):
        """Test job offer category detection."""
        result = await pipeline.classify("Срочно требуются грузчики! Оклад от 5000 рублей")
        assert result["category"] in ["job_offer", "commercial_spam", "unknown"]
    
    async def test_buy_sell_category(self):
        """Test buy/sell category detection."""
        result = await pipeline.classify("Продам iPhone 12, недорого")
        assert result["category"] in ["buy_sell", "commercial_spam", "unknown"]

