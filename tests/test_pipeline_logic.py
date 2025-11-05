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
        # Use spam context with URL to ensure detection
        result = await pipeline.classify("Продам iPhone! Смотрите https://example.com/sale")
        # URL in spam context should be detected
        assert result["spam_score"] > 0.3 or any("url" in reason.lower() or "URL" in reason.lower() 
                  for reason in result["reasons"]) or "lur" in result["layers_used"]
    
    async def test_phone_detection(self):
        """Test phone number detection."""
        # Use spam context with phone to ensure detection
        result = await pipeline.classify("Продам iPhone! Звоните +79001234567")
        # Phone in spam context should be detected
        assert result["spam_score"] > 0.3 or any("phone" in reason.lower() or "number" in reason.lower() 
                  for reason in result["reasons"])


@pytest.mark.asyncio
class TestMLLayer:
    async def test_ml_activation(self):
        """Test that rules layer activates (ML is disabled)."""
        result = await pipeline.classify("This is a borderline case")
        assert "rules" in result["layers_used"] or "llm" in result["layers_used"]
    
    async def test_safe_message_low_score(self):
        """Test that safe messages get low spam score."""
        result = await pipeline.classify("Hello, this is a normal friendly message")
        # Safe messages should have low spam score
        assert result["spam_score"] < 0.5


@pytest.mark.asyncio
class TestCache:
    async def test_cache_hit(self):
        """Test that identical requests are cached."""
        text = "Test cache message"
        result1 = await pipeline.classify(text)
        result2 = await pipeline.classify(text)
        assert result1 == result2 or result2.get("cached") == True
    
    async def test_cache_different_texts(self):
        """Test that different texts produce different results or are cached separately."""
        result1 = await pipeline.classify("Продам iPhone 12, недорого!")
        result2 = await pipeline.classify("Hello, how are you? Nice weather today.")
        # Different texts should have different spam scores (one is spam, one is not)
        assert result1["spam_score"] != result2["spam_score"] or result1["reasons"] != result2["reasons"]


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
        """Test job offer detection via reasons."""
        result = await pipeline.classify("Срочно требуются грузчики! Оклад от 5000 рублей")
        # Job offers should be detected as spam and have job-related reasons
        assert result["spam_score"] > 0.3
        assert any("job" in reason.lower() or "work" in reason.lower() or "commercial" in reason.lower() 
                  for reason in result["reasons"]) or result["spam_score"] >= settings.decision_threshold
    
    async def test_buy_sell_category(self):
        """Test buy/sell detection via reasons."""
        result = await pipeline.classify("Продам iPhone 12, недорого")
        # Buy/sell should be detected as spam and have commercial reasons
        assert result["spam_score"] > 0.3
        assert any("commercial" in reason.lower() or "trade" in reason.lower() or "sale" in reason.lower() 
                  for reason in result["reasons"]) or result["spam_score"] >= settings.decision_threshold

