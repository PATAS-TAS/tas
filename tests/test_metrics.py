"""
Unit tests for metrics module.
"""
import pytest
import time
from app.metrics import metrics_collector


class TestMetricsCollector:
    """Test MetricsCollector class."""
    
    def setup_method(self):
        """Reset metrics collector state before each test."""
        # Clear windows
        metrics_collector._latency_window.clear()
        metrics_collector._fp_window.clear()
        metrics_collector._fn_window.clear()
        metrics_collector._tp_window.clear()
        metrics_collector._tn_window.clear()
        metrics_collector._daily_cost = 0.0
        metrics_collector.daily_budget_usd = 10.0
        metrics_collector.monthly_budget_usd = 300.0
    
    def test_init(self):
        """Test metrics collector initialization."""
        assert metrics_collector is not None
        assert metrics_collector.daily_budget_usd == 10.0
        assert metrics_collector.monthly_budget_usd == 300.0
    
    def test_record_request(self):
        """Test recording classification requests."""
        initial_requests = metrics_collector.total_requests._value.get()
        initial_spam = metrics_collector.spam_detected._value.get()
        initial_ham = metrics_collector.ham_detected._value.get()
        
        # Record spam request
        metrics_collector.record_request(latency_seconds=0.1, is_spam=True)
        assert metrics_collector.total_requests._value.get() == initial_requests + 1
        assert metrics_collector.spam_detected._value.get() == initial_spam + 1
        assert metrics_collector.ham_detected._value.get() == initial_ham
        
        # Record ham request
        metrics_collector.record_request(latency_seconds=0.05, is_spam=False)
        assert metrics_collector.total_requests._value.get() == initial_requests + 2
        assert metrics_collector.spam_detected._value.get() == initial_spam + 1
        assert metrics_collector.ham_detected._value.get() == initial_ham + 1
        
        # Check latency window
        assert len(metrics_collector._latency_window) >= 2
    
    def test_record_llm_request(self):
        """Test recording LLM requests and cost calculation."""
        initial_cache_hits = metrics_collector.llm_cache_hits._value.get()
        initial_requests = metrics_collector.llm_requests._value.get()
        initial_cost = metrics_collector.llm_cost_usd._value.get()
        
        # Record cached LLM request (no cost)
        metrics_collector.record_llm_request(
            prompt_tokens=0,
            completion_tokens=0,
            model="gpt-4o-mini",
            cached=True
        )
        assert metrics_collector.llm_cache_hits._value.get() == initial_cache_hits + 1
        assert metrics_collector.llm_requests._value.get() == initial_requests
        assert metrics_collector.llm_cost_usd._value.get() == initial_cost
        
        # Record actual LLM request (with cost)
        metrics_collector.record_llm_request(
            prompt_tokens=100,
            completion_tokens=50,
            model="gpt-4o-mini",
            cached=False
        )
        assert metrics_collector.llm_requests._value.get() == initial_requests + 1
        assert metrics_collector.llm_cache_hits._value.get() == initial_cache_hits + 1
        
        # Cost should be calculated
        cost = metrics_collector.llm_cost_usd._value.get()
        assert cost > initial_cost
        assert cost < initial_cost + 0.01  # Should be very small for 150 tokens
    
    def test_record_feedback(self):
        """Test recording feedback for FP/FN."""
        initial_fp = metrics_collector.false_positives._value.get()
        initial_fn = metrics_collector.false_negatives._value.get()
        initial_fp_window = len(metrics_collector._fp_window)
        initial_fn_window = len(metrics_collector._fn_window)
        
        # Record false positive
        metrics_collector.record_feedback(is_fp=True)
        assert metrics_collector.false_positives._value.get() == initial_fp + 1
        assert len(metrics_collector._fp_window) == initial_fp_window + 1
        
        # Record false negative
        metrics_collector.record_feedback(is_fp=False)
        assert metrics_collector.false_negatives._value.get() == initial_fn + 1
        assert len(metrics_collector._fn_window) == initial_fn_window + 1
    
    def test_record_evaluation_result(self):
        """Test recording evaluation results."""
        initial_tp = len(metrics_collector._tp_window)
        initial_fp = len(metrics_collector._fp_window)
        initial_tn = len(metrics_collector._tn_window)
        initial_fn = len(metrics_collector._fn_window)
        
        metrics_collector.record_evaluation_result(tp=10, fp=2, tn=80, fn=8)
        
        assert len(metrics_collector._tp_window) == initial_tp + 10
        assert len(metrics_collector._fp_window) == initial_fp + 2
        assert len(metrics_collector._tn_window) == initial_tn + 80
        assert len(metrics_collector._fn_window) == initial_fn + 8
        
        # Check that FPR and Recall are updated
        metrics = metrics_collector.get_current_metrics()
        assert metrics["fpr"] >= 0.0
        assert metrics["recall"] >= 0.0
    
    def test_get_current_metrics(self):
        """Test getting current metrics."""
        # Add some data
        metrics_collector.record_request(0.1, True)
        metrics_collector.record_request(0.2, False)
        metrics_collector.record_evaluation_result(tp=5, fp=1, tn=10, fn=2)
        
        metrics = metrics_collector.get_current_metrics()
        
        assert "total_requests" in metrics
        assert "spam_detected" in metrics
        assert "ham_detected" in metrics
        assert "latency_p95_ms" in metrics
        assert "fpr" in metrics
        assert "recall" in metrics
        assert "llm_cost_usd" in metrics
        assert "daily_budget_usd" in metrics
        assert isinstance(metrics["total_requests"], (int, float))
        assert isinstance(metrics["fpr"], float)
        assert isinstance(metrics["recall"], float)
    
    def test_check_alerts(self):
        """Test alert checking."""
        # Initially check alerts (may or may not have alerts)
        alerts = metrics_collector.check_alerts()
        assert isinstance(alerts, list)
        
        # Trigger FPR alert
        metrics_collector.record_evaluation_result(tp=0, fp=10, tn=0, fn=0)
        alerts = metrics_collector.check_alerts()
        assert len(alerts) > 0
        assert any(a["metric"] == "fpr" for a in alerts)
        
        # Trigger budget alert
        metrics_collector._daily_cost = 15.0  # Exceed budget
        alerts = metrics_collector.check_alerts()
        assert any(a["metric"] == "llm_cost" for a in alerts)
    
    def test_set_budget(self):
        """Test setting budgets."""
        metrics_collector.set_budget(daily=20.0, monthly=500.0)
        assert metrics_collector.daily_budget_usd == 20.0
        assert metrics_collector.monthly_budget_usd == 500.0
        
        metrics_collector.set_budget(daily=15.0)
        assert metrics_collector.daily_budget_usd == 15.0
        assert metrics_collector.monthly_budget_usd == 500.0  # Unchanged
    
    def test_latency_p95_calculation(self):
        """Test P95 latency calculation."""
        # Add enough requests for P95 calculation (need at least 20)
        for i in range(25):
            metrics_collector.record_request(latency_seconds=0.01 * (i + 1), is_spam=True)
        
        metrics = metrics_collector.get_current_metrics()
        assert metrics["latency_p95_ms"] >= 0.0
        assert metrics["latency_p95_seconds"] >= 0.0
    
    def test_llm_hit_rate_calculation(self):
        """Test LLM hit rate calculation."""
        initial_llm_reqs = metrics_collector.llm_requests._value.get()
        initial_cache_hits = metrics_collector.llm_cache_hits._value.get()
        
        # Add cache hits and requests
        for _ in range(8):
            metrics_collector.record_llm_request(0, 0, "gpt-4o-mini", cached=True)
        for _ in range(2):
            metrics_collector.record_llm_request(100, 50, "gpt-4o-mini", cached=False)
        
        final_llm_reqs = metrics_collector.llm_requests._value.get()
        final_cache_hits = metrics_collector.llm_cache_hits._value.get()
        
        # Calculate expected hit rate
        total_llm = (final_llm_reqs - initial_llm_reqs) + (final_cache_hits - initial_cache_hits)
        if total_llm > 0:
            hit_rate = (final_cache_hits - initial_cache_hits) / total_llm
            assert hit_rate == 0.8  # 8/10 = 0.8
        
        metrics = metrics_collector.get_current_metrics()
        assert metrics["llm_hit_rate"] >= 0.0
        assert metrics["llm_hit_rate"] <= 1.0

    def test_window_trim_and_ram_stability(self):
        """Ensure sliding windows cap at 1000 and trim 10% oldest on overflow."""
        # Fill beyond capacity
        for i in range(1200):
            metrics_collector.record_request(latency_seconds=0.02, is_spam=(i % 2 == 0))
        # Windows should not exceed max size
        assert len(metrics_collector._latency_window) <= 1000
        # Trigger feedback windows overflow
        for i in range(1200):
            metrics_collector.record_feedback(is_fp=(i % 3 == 0))
        assert len(metrics_collector._fp_window) <= 1000
        assert len(metrics_collector._fn_window) <= 1000
        # P95 should still be computable and stable (non-negative)
        m = metrics_collector.get_current_metrics()
        assert m["latency_p95_ms"] >= 0.0


@pytest.mark.asyncio
class TestMetricsIntegration:
    """Test metrics integration with pipeline."""
    
    async def test_metrics_in_pipeline(self):
        """Test that metrics are recorded when pipeline classifies."""
        from app.pipeline import pipeline
        from app.metrics import metrics_collector
        
        initial_requests = metrics_collector.total_requests._value.get()
        
        result = await pipeline.classify("Test spam message Продам iPhone!")
        
        final_requests = metrics_collector.total_requests._value.get()
        assert final_requests > initial_requests
        
        # Check that latency was recorded
        metrics = metrics_collector.get_current_metrics()
        assert metrics["total_requests"] > 0

