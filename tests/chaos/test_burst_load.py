"""
Chaos tests: Burst load simulation.
Tests system behavior under high load (1500 rps for 60 seconds).
"""
import pytest
import asyncio
import time
import httpx
from concurrent.futures import ThreadPoolExecutor
from statistics import mean


@pytest.mark.asyncio
async def test_burst_load_1500_rps():
    """Test system under burst load of 1500 rps for 60 seconds."""
    base_url = "http://localhost:8000"
    target_rps = 1500
    duration_seconds = 60
    
    # Generate test messages
    messages = [
        "Скидки -70% сегодня!",
        "Hello, how are you?",
        "bit.ly/xxx",
        "Work from home, earn $1000/day",
        "Normal conversation message"
    ] * 1000  # Generate enough messages
    
    async def make_request(client: httpx.AsyncClient, text: str):
        """Make a single classification request."""
        try:
            start = time.time()
            response = await client.post(
                f"{base_url}/v1/classify",
                json={"text": text},
                headers={"x-api-key": "test-key"},
                timeout=5.0
            )
            latency = (time.time() - start) * 1000  # ms
            
            return {
                'status': response.status_code,
                'latency_ms': latency,
                'success': response.status_code == 200
            }
        except Exception as e:
            return {
                'status': 0,
                'latency_ms': 0,
                'success': False,
                'error': str(e)
            }
    
    # Run burst load
    async with httpx.AsyncClient() as client:
        start_time = time.time()
        results = []
        
        # Calculate requests per batch to achieve target RPS
        requests_per_batch = target_rps // 10  # 10 batches per second
        batch_interval = 0.1  # 100ms between batches
        
        while time.time() - start_time < duration_seconds:
            batch_start = time.time()
            
            # Create batch of requests
            batch_tasks = [
                make_request(client, messages[i % len(messages)])
                for i in range(requests_per_batch)
            ]
            
            batch_results = await asyncio.gather(*batch_tasks)
            results.extend(batch_results)
            
            # Wait for next batch interval
            elapsed = time.time() - batch_start
            sleep_time = max(0, batch_interval - elapsed)
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)
    
    total_time = time.time() - start_time
    actual_rps = len(results) / total_time
    
    # Analyze results
    successful = [r for r in results if r['success']]
    failed = [r for r in results if not r['success']]
    
    latencies = [r['latency_ms'] for r in successful]
    latencies_sorted = sorted(latencies)
    
    metrics = {
        'total_requests': len(results),
        'successful': len(successful),
        'failed': len(failed),
        'error_rate': len(failed) / len(results) if results else 0,
        'actual_rps': actual_rps,
        'target_rps': target_rps,
        'latency_p50_ms': latencies_sorted[len(latencies_sorted)//2] if latencies_sorted else 0,
        'latency_p95_ms': latencies_sorted[int(len(latencies_sorted)*0.95)] if latencies_sorted else 0,
        'latency_p99_ms': latencies_sorted[int(len(latencies_sorted)*0.99)] if latencies_sorted else 0,
        'latency_avg_ms': mean(latencies) if latencies else 0,
    }
    
    # Assertions
    # Error rate should be low (< 1%)
    assert metrics['error_rate'] < 0.01, f"Error rate {metrics['error_rate']:.2%} exceeds 1%"
    
    # P95 latency for rules-only should be reasonable (< 250ms)
    # Note: With LLM, P95 may be higher, but rules-only should be fast
    assert metrics['latency_p95_ms'] < 250, f"P95 latency {metrics['latency_p95_ms']:.1f}ms exceeds 250ms"
    
    # System should handle at least 80% of target RPS
    assert actual_rps >= target_rps * 0.8, f"Actual RPS {actual_rps:.1f} is below 80% of target {target_rps}"
    
    print(f"\n=== Burst Load Test Results ===")
    print(f"Total requests: {metrics['total_requests']}")
    print(f"Successful: {metrics['successful']}, Failed: {metrics['failed']}")
    print(f"Error rate: {metrics['error_rate']:.2%}")
    print(f"Actual RPS: {metrics['actual_rps']:.1f} (target: {metrics['target_rps']})")
    print(f"Latency P50: {metrics['latency_p50_ms']:.1f}ms")
    print(f"Latency P95: {metrics['latency_p95_ms']:.1f}ms")
    print(f"Latency P99: {metrics['latency_p99_ms']:.1f}ms")


def test_queue_does_not_grow_unbounded():
    """Test that request queues don't grow unbounded under load."""
    # This test would require monitoring queue sizes
    # For now, we verify that latency doesn't continuously increase
    # (which would indicate queue buildup)
    
    base_url = "http://localhost:8000"
    
    # Make requests in bursts
    latencies = []
    for burst in range(5):
        burst_latencies = []
        for i in range(100):
            start = time.time()
            response = httpx.post(
                f"{base_url}/v1/classify",
                json={"text": f"Test message {i}"},
                headers={"x-api-key": "test-key"},
                timeout=5.0
            )
            latency = (time.time() - start) * 1000
            burst_latencies.append(latency)
        
        avg_latency = mean(burst_latencies)
        latencies.append(avg_latency)
        
        # Small delay between bursts
        time.sleep(0.5)
    
    # Latency should not continuously increase (indicates queue buildup)
    # Allow some variance, but trend should be stable
    first_half = mean(latencies[:3])
    second_half = mean(latencies[2:])
    
    # Second half should not be more than 2x first half
    assert second_half < first_half * 2, f"Latency increased from {first_half:.1f}ms to {second_half:.1f}ms (possible queue buildup)"


def test_cache_reduces_latency():
    """Test that cache hits reduce latency and LLM hit rate."""
    base_url = "http://localhost:8000"
    
    # First request (cache miss)
    text = "Скидки -70% сегодня, пишите в тг @sale_best!"
    
    start1 = time.time()
    response1 = httpx.post(
        f"{base_url}/v1/classify",
        json={"text": text},
        headers={"x-api-key": "test-key"},
        timeout=5.0
    )
    latency1 = (time.time() - start1) * 1000
    
    # Second request (cache hit)
    start2 = time.time()
    response2 = httpx.post(
        f"{base_url}/v1/classify",
        json={"text": text},
        headers={"x-api-key": "test-key"},
        timeout=5.0
    )
    latency2 = (time.time() - start2) * 1000
    
    # Cached request should be faster
    assert latency2 < latency1, f"Cached request ({latency2:.1f}ms) should be faster than uncached ({latency1:.1f}ms)"
    
    # Both should succeed
    assert response1.status_code == 200
    assert response2.status_code == 200

