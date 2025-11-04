import pytest
import asyncio
import time
from app.pipeline import pipeline


@pytest.mark.asyncio
async def test_latency_p95():
    """Test P95 latency is under 100ms."""
    test_texts = [
        "Привет",
        "Hello, how are you?",
        "Продам iPhone 12, недорого!",
        "Работа на дому! Заработок!",
        "Normal conversation message",
    ] * 20
    
    latencies = []
    
    for text in test_texts:
        start = time.time()
        await pipeline.classify(text, "en")
        latency = (time.time() - start) * 1000
        latencies.append(latency)
    
    latencies.sort()
    p50 = latencies[len(latencies) // 2]
    p95 = latencies[int(len(latencies) * 0.95)]
    p99 = latencies[int(len(latencies) * 0.99)]
    
    print(f"P50: {p50:.2f}ms")
    print(f"P95: {p95:.2f}ms")
    print(f"P99: {p99:.2f}ms")
    
    assert p95 < 100, f"P95 latency {p95:.2f}ms exceeds 100ms target"


@pytest.mark.asyncio
async def test_throughput():
    """Test throughput (requests per second)."""
    test_text = "Test message for throughput"
    iterations = 50
    start_time = time.time()
    
    for i in range(iterations):
        await pipeline.classify(test_text, "en")
    
    elapsed = time.time() - start_time
    rps = iterations / elapsed
    
    print(f"Throughput: {rps:.2f} req/sec")
    print(f"Target: 100+ req/sec")
    
    assert rps > 50, f"Throughput {rps:.2f} req/sec is too low"


@pytest.mark.asyncio
async def test_concurrent_requests():
    """Test concurrent request handling."""
    async def classify_task(text):
        return await pipeline.classify(text, "en")
    
    tasks = [classify_task(f"Message {i}") for i in range(20)]
    start = time.time()
    results = await asyncio.gather(*tasks)
    elapsed = time.time() - start
    
    print(f"20 concurrent requests: {elapsed*1000:.2f}ms")
    print(f"Average per request: {elapsed*1000/20:.2f}ms")
    
    assert elapsed < 2.0, "Concurrent requests took too long"
    assert len(results) == 20
