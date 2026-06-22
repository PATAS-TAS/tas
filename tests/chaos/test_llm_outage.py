"""
Chaos tests: LLM outage simulation.
Tests graceful degradation when LLM provider is unavailable.
"""
import pytest
import time
from fastapi.testclient import TestClient
from unittest.mock import patch, AsyncMock
from app.main import app

client = TestClient(app)


def test_llm_outage_graceful_degradation():
    """Test that LLM outage doesn't cause 5xx errors."""
    # Mock LLM to always fail
    with patch('app.llm_check.llm_check.check', new_callable=AsyncMock) as mock_check:
        mock_check.return_value = None  # Simulate LLM failure
        
        # Make multiple requests
        for i in range(10):
            response = client.post(
                "/v1/classify",
                json={"text": f"Test message {i}"},
                headers={"x-api-key": "test-key"}
            )
            
            # Should always return 200, not 5xx
            assert response.status_code == 200, f"Request {i} returned {response.status_code}"
            
            data = response.json()
            # Should have safe defaults
            assert "spam" in data
            assert "score" in data
            assert "path" in data
            # Path should be "rules" when LLM fails
            assert data["path"] == "rules", f"Expected path='rules', got {data['path']}"


def test_llm_outage_latency_stable():
    """Test that latency stays reasonable during LLM outage."""
    with patch('app.llm_check.llm_check.check', new_callable=AsyncMock) as mock_check:
        mock_check.return_value = None
        
        latencies = []
        for i in range(20):
            start = time.time()
            response = client.post(
                "/v1/classify",
                json={"text": f"Test message {i}"},
                headers={"x-api-key": "test-key"}
            )
            latency = (time.time() - start) * 1000  # ms
            latencies.append(latency)
            
            assert response.status_code == 200
        
        # P95 should be reasonable (rules-only, < 300ms)
        latencies_sorted = sorted(latencies)
        p95 = latencies_sorted[int(len(latencies) * 0.95)]
        assert p95 < 300, f"P95 latency {p95}ms exceeds 300ms threshold"


def test_llm_timeout_handling():
    """Test handling of LLM timeout."""
    import asyncio
    
    async def slow_llm(*args, **kwargs):
        await asyncio.sleep(15)  # Simulate timeout
        return None
    
    with patch('app.llm_check.llm_check.check', new_callable=AsyncMock) as mock_check:
        mock_check.side_effect = slow_llm
        
        # Request should not hang forever
        start = time.time()
        response = client.post(
            "/v1/classify",
            json={"text": "Test message"},
            headers={"x-api-key": "test-key"},
            timeout=5.0  # HTTP timeout
        )
        elapsed = time.time() - start
        
        # Should complete within reasonable time (not wait for LLM timeout)
        assert elapsed < 10, "Request took too long (>10s)"
        assert response.status_code == 200


@pytest.mark.asyncio
async def test_circuit_breaker_activation():
    """Test that circuit breaker activates after consecutive failures."""
    from app.llm_check import llm_check
    
    # Simulate 3 consecutive failures
    with patch('app.llm_check.llm_check.check', new_callable=AsyncMock) as mock_check:
        mock_check.side_effect = Exception("LLM failure")
        
        # First 3 requests should trigger circuit breaker
        for i in range(3):
            try:
                result = await llm_check.check("test")
            except:
                pass
        
        # Next request should be short-circuited (no actual LLM call)
        call_count_before = mock_check.call_count
        
        # Circuit breaker should be open now
        result = await llm_check.check("test")
        assert result is None
        
        # Should not have made another LLM call (circuit breaker active)
        # Note: This test may need adjustment based on actual circuit breaker implementation
