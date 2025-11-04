import pytest
import asyncio
from app.pipeline import pipeline
from app.config import settings


class TestIntegratedPipeline:
    """Test integrated pipeline with all modules."""
    
    @pytest.mark.asyncio
    async def test_basic_classification(self):
        """Test basic classification without modules."""
        result = await pipeline.classify("Hello, how are you?", "en")
        assert "spam_score" in result
        assert "confidence" in result
        assert result["spam_score"] < 0.5
    
    @pytest.mark.asyncio
    async def test_with_sender_id_rrs(self):
        """Test RRS module with sender_id."""
        sender_id = "test_user_rrs_123"
        
        for i in range(6):
            await pipeline.classify(
                "Test message", 
                "en", 
                sender_id=sender_id
            )
        
        result = await pipeline.classify(
            "Another message", 
            "en", 
            sender_id=sender_id
        )
        
        assert "rrs" in result.get("layers_used", []), f"RRS not in layers: {result.get('layers_used')}"
    
    @pytest.mark.asyncio
    async def test_with_url_lur(self):
        """Test LUR module with URL."""
        result = await pipeline.classify(
            "Check this out: https://bit.ly/spam-link", 
            "en"
        )
        
        assert "lur" in result.get("layers_used", []), f"LUR not in layers: {result.get('layers_used')}"
        assert result["spam_score"] > 0.3
    
    @pytest.mark.asyncio
    async def test_signature_sig(self):
        """Test SIG module."""
        text = "Продам iPhone 12, недорого!"
        result = await pipeline.classify(text, "ru")
        
        assert "sig" in result.get("layers_used", []), f"SIG not in layers: {result.get('layers_used')}"
    
    @pytest.mark.asyncio
    async def test_quarantine_qzn(self):
        """Test QZN module."""
        message_id = "msg_123"
        text = "Продам iPhone 12, недорого! Звоните +79001234567"
        
        result = await pipeline.classify(
            text, 
            "ru", 
            message_id=message_id
        )
        
        assert result["spam_score"] >= 0.5
    
    @pytest.mark.asyncio
    async def test_all_modules_together(self):
        """Test all modules working together."""
        sender_id = "spammer_123"
        message_id = "msg_456"
        text = "Работа на дому! Заработок! Звоните +79001234567 https://bit.ly/scam"
        
        for i in range(5):
            await pipeline.classify("Test", "en", sender_id=sender_id)
        
        result = await pipeline.classify(
            text, 
            "ru", 
            sender_id=sender_id,
            message_id=message_id
        )
        
        assert result["spam_score"] >= 0.5
        assert "is_spam" in str(result) or result["spam_score"] >= 0.5
        
        layers = result.get("layers_used", [])
        assert "rules" in layers


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

