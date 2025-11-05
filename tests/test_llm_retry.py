"""
Unit tests for LLM retry logic.
"""
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from app.llm_check import LLMCheck


class TestLLMRetry:
    """Test LLM retry logic with exponential backoff."""
    
    @pytest.fixture
    def mock_client(self):
        """Mock OpenAI client."""
        client = AsyncMock()
        return client
    
    @pytest.mark.asyncio
    async def test_successful_request_no_retry(self, mock_client):
        """Test successful request without retries."""
        llm = LLMCheck()
        llm.enabled = True
        llm.client = mock_client
        
        # Mock successful response
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = '{"is_spam": false, "confidence": 0.3, "reasons": []}'
        mock_response.usage = MagicMock()
        mock_response.usage.prompt_tokens = 50
        mock_response.usage.completion_tokens = 20
        
        mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
        
        result = await llm.check("Test message")
        
        assert result is not None
        assert result["spam"] == 0.0
        assert mock_client.chat.completions.create.call_count == 1
    
    @pytest.mark.asyncio
    async def test_retry_on_failure_then_success(self, mock_client):
        """Test retry logic: fail twice, then succeed."""
        llm = LLMCheck()
        llm.enabled = True
        llm.client = mock_client
        
        # Mock response for success
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = '{"is_spam": true, "confidence": 0.8, "reasons": ["spam"]}'
        mock_response.usage = MagicMock()
        mock_response.usage.prompt_tokens = 50
        mock_response.usage.completion_tokens = 20
        
        # First two calls fail, third succeeds
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[
                Exception("Network error"),
                Exception("Timeout"),
                mock_response
            ]
        )
        
        with patch('asyncio.sleep', new_callable=AsyncMock) as mock_sleep:
            result = await llm.check("Test message")
            
            assert result is not None
            assert result["spam"] == 1.0
            assert mock_client.chat.completions.create.call_count == 3
            # Should have slept twice (0.5s and 1.0s)
            assert mock_sleep.call_count == 2
            assert mock_sleep.call_args_list[0][0][0] == 0.5
            assert mock_sleep.call_args_list[1][0][0] == 1.0
    
    @pytest.mark.asyncio
    async def test_all_retries_exhausted_returns_none(self, mock_client):
        """Test that after 3 failed attempts, returns None for rules-only fallback."""
        llm = LLMCheck()
        llm.enabled = True
        llm.client = mock_client
        
        # All attempts fail
        mock_client.chat.completions.create = AsyncMock(
            side_effect=Exception("Persistent error")
        )
        
        with patch('asyncio.sleep', new_callable=AsyncMock):
            result = await llm.check("Test message")
            
            assert result is None
            assert mock_client.chat.completions.create.call_count == 3
    
    @pytest.mark.asyncio
    async def test_backoff_delays(self, mock_client):
        """Test that backoff delays are correct (0.5s, 1.0s, 2.0s)."""
        llm = LLMCheck()
        llm.enabled = True
        llm.client = mock_client
        
        mock_client.chat.completions.create = AsyncMock(
            side_effect=Exception("Error")
        )
        
        with patch('asyncio.sleep', new_callable=AsyncMock) as mock_sleep:
            await llm.check("Test message")
            
            # Should have 3 attempts, 2 sleeps (before 2nd and 3rd attempt)
            assert mock_sleep.call_count == 2
            assert mock_sleep.call_args_list[0][0][0] == 0.5  # First backoff
            assert mock_sleep.call_args_list[1][0][0] == 1.0  # Second backoff
    
    @pytest.mark.asyncio
    async def test_cached_result_no_retry(self, mock_client):
        """Test that cached results don't trigger retry logic."""
        llm = LLMCheck()
        llm.enabled = True
        llm.client = mock_client
        
        # Pre-populate cache
        cached_result = {
            "spam": 0.5,
            "confidence": 0.5,
            "reasons": ["test"],
            "model": "gpt-4o-mini"
        }
        cache_key = llm._cache_key("Test message")
        llm.cache[cache_key] = cached_result
        
        result = await llm.check("Test message")
        
        assert result == cached_result
        # Should not call LLM at all
        assert mock_client.chat.completions.create.call_count == 0
    
    @pytest.mark.asyncio
    async def test_disabled_llm_returns_none(self):
        """Test that disabled LLM returns None immediately."""
        llm = LLMCheck()
        llm.enabled = False
        llm.client = None
        
        result = await llm.check("Test message")
        
        assert result is None

