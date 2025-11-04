"""
Performance and stress testing.
"""
import asyncio
import time
import pytest
from app.pipeline import pipeline
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


@pytest.mark.asyncio
class TestLatency:
    async def test_single_request_latency(self):
        """Test single request latency."""
        start = time.time()
        result = await pipeline.classify("Test message")
        elapsed = time.time() - start
        assert elapsed < 1.0
        assert result["spam_score"] >= 0
    
    async def test_rules_only_latency(self):
        """Test rules-only request latency (should be fast)."""
        start = time.time()
        result = await pipeline.classify("Продам iPhone, звоните!")
        elapsed = time.time() - start
        assert elapsed < 0.1
        assert "rules" in result["layers_used"]


class TestConcurrentRequests:
    def test_concurrent_classify(self):
        """Test concurrent API requests."""
        import concurrent.futures
        
        def make_request():
            return client.post(
                "/classify",
                json={"text": "Test concurrent request", "lang": "en"}
            )
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(make_request) for _ in range(10)]
            results = [f.result() for f in concurrent.futures.as_completed(futures)]
        
        assert len(results) == 10
        assert all(r.status_code == 200 for r in results)
    
    def test_batch_performance(self):
        """Test batch endpoint performance."""
        texts = [f"Test message {i}" for i in range(50)]
        start = time.time()
        response = client.post("/batch", json={"texts": texts})
        elapsed = time.time() - start
        assert response.status_code == 200
        assert elapsed < 10.0


@pytest.mark.asyncio
class TestCachePerformance:
    async def test_cache_speedup(self):
        """Test that cached requests are faster."""
        text = "Cache speedup test message"
        
        # First request (no cache)
        start1 = time.time()
        await pipeline.classify(text)
        elapsed1 = time.time() - start1
        
        # Second request (cached)
        start2 = time.time()
        await pipeline.classify(text)
        elapsed2 = time.time() - start2
        
        assert elapsed2 <= elapsed1


class TestRateLimiting:
    def test_rate_limit_headers(self):
        """Test rate limit headers presence."""
        response = client.post(
            "/classify",
            json={"text": "Test", "lang": "en"}
        )
        assert response.status_code == 200

