"""
Prometheus metrics collection for TAS API.
Tracks latency, FPR, recall, LLM hit rate, and costs.
"""
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from typing import Dict, Optional, List, Any
from collections import deque
from datetime import datetime, timezone
import threading
import statistics
import logging

logger = logging.getLogger(__name__)


class MetricsCollector:
    """Collects and exposes Prometheus metrics."""
    
    def __init__(self):
        # Latency histogram (P95, P99, etc.)
        self.latency_histogram = Histogram(
            'tas_classify_latency_seconds',
            'Latency of classify requests in seconds',
            buckets=[0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 2.0, 5.0]
        )
        
        # Request counters
        self.total_requests = Counter(
            'tas_total_requests',
            'Total number of classification requests'
        )
        
        self.spam_detected = Counter(
            'tas_spam_detected',
            'Total number of spam messages detected'
        )
        
        self.ham_detected = Counter(
            'tas_ham_detected',
            'Total number of legitimate messages detected'
        )
        
        # LLM metrics
        self.llm_requests = Counter(
            'tas_llm_requests_total',
            'Total number of LLM requests'
        )
        
        self.llm_cache_hits = Counter(
            'tas_llm_cache_hits_total',
            'Total number of LLM cache hits'
        )
        
        self.llm_tokens_used = Counter(
            'tas_llm_tokens_total',
            'Total number of LLM tokens used',
            ['type']  # 'prompt' or 'completion'
        )
        
        # Cost tracking
        self.llm_cost_usd = Counter(
            'tas_llm_cost_usd_total',
            'Total LLM cost in USD'
        )
        
        # Performance metrics (gauges for current values)
        self.fpr_gauge = Gauge(
            'tas_false_positive_rate',
            'Current false positive rate (0.0-1.0)'
        )
        
        self.recall_gauge = Gauge(
            'tas_recall',
            'Current recall (0.0-1.0)'
        )
        
        self.llm_hit_rate_gauge = Gauge(
            'tas_llm_hit_rate',
            'Current LLM cache hit rate (0.0-1.0)'
        )
        
        self.latency_p95_gauge = Gauge(
            'tas_latency_p95_seconds',
            'Current P95 latency in seconds'
        )
        
        # External providers health (1=up, 0=down)
        self.provider_health_gauge = Gauge(
            'tas_provider_health',
            'External provider health status (1=up, 0=down)',
            ['provider']
        )
        self._provider_health: Dict[str, Dict[str, Any]] = {}

        # Feedback metrics
        self.false_positives = Counter(
            'tas_false_positives_total',
            'Total false positives reported via feedback'
        )
        
        self.false_negatives = Counter(
            'tas_false_negatives_total',
            'Total false negatives reported via feedback'
        )
        
        # Internal tracking for sliding window calculations
        self._window_max_size = 1000
        self._trim_fraction = 0.10  # remove oldest 10% on overflow
        self._latency_window = deque(maxlen=self._window_max_size)
        self._fp_window = deque(maxlen=self._window_max_size)
        self._fn_window = deque(maxlen=self._window_max_size)
        self._tp_window = deque(maxlen=self._window_max_size)
        self._tn_window = deque(maxlen=self._window_max_size)
        
        self._lock = threading.Lock()
        
        # LLM pricing (gpt-4o-mini as of 2024)
        self.llm_pricing = {
            "gpt-4o-mini": {
                "prompt": 0.15 / 1_000_000,  # $0.15 per 1M tokens
                "completion": 0.60 / 1_000_000,  # $0.60 per 1M tokens
            }
        }
        
        # Cost budget (configurable)
        self.daily_budget_usd = 10.0  # Default $10/day
        self.monthly_budget_usd = 300.0  # Default $300/month
        
        # Daily cost tracking
        self._daily_cost = 0.0
        self._daily_cost_date = datetime.now(timezone.utc).date()
        self._monthly_cost = 0.0
        self._monthly_cost_month = datetime.now(timezone.utc).month
        
    def record_request(self, latency_seconds: float, is_spam: bool):
        """Record a classification request."""
        with self._lock:
            self.total_requests.inc()
            self.latency_histogram.observe(latency_seconds)
            self._append_with_trim(self._latency_window, latency_seconds)
            
            if is_spam:
                self.spam_detected.inc()
            else:
                self.ham_detected.inc()
            
            # Update P95 latency gauge
            if len(self._latency_window) >= 20:
                p95 = statistics.quantiles(self._latency_window, n=20)[18]
                self.latency_p95_gauge.set(p95)
    
    def record_llm_request(
        self,
        prompt_tokens: int,
        completion_tokens: int,
        model: str = "gpt-4o-mini",
        cached: bool = False
    ):
        """Record an LLM request and calculate cost."""
        with self._lock:
            if cached:
                self.llm_cache_hits.inc()
            else:
                self.llm_requests.inc()
                self.llm_tokens_used.labels(type='prompt').inc(prompt_tokens)
                self.llm_tokens_used.labels(type='completion').inc(completion_tokens)
                
                # Calculate cost
                pricing = self.llm_pricing.get(model, self.llm_pricing["gpt-4o-mini"])
                cost = (prompt_tokens * pricing["prompt"]) + (completion_tokens * pricing["completion"])
                self.llm_cost_usd.inc(cost)
                self._daily_cost += cost
                self._monthly_cost += cost
                
                # Reset daily cost if new day
                current_date = datetime.now(timezone.utc).date()
                if current_date != self._daily_cost_date:
                    self._daily_cost = cost
                    self._daily_cost_date = current_date
                
                # Reset monthly cost if new month
                current_month = datetime.now(timezone.utc).month
                if current_month != self._monthly_cost_month:
                    self._monthly_cost = cost
                    self._monthly_cost_month = current_month
            
            # Update LLM hit rate
            total_llm_attempts = self.llm_requests._value.get() + self.llm_cache_hits._value.get()
            if total_llm_attempts > 0:
                hit_rate = self.llm_cache_hits._value.get() / total_llm_attempts
                self.llm_hit_rate_gauge.set(hit_rate)

    def set_provider_health(self, provider: str, up: bool, down_seconds_remaining: float = 0.0, failures_consecutive: int = 0):
        """Update provider health status for dashboards and Prometheus."""
        with self._lock:
            self.provider_health_gauge.labels(provider=provider).set(1.0 if up else 0.0)
            self._provider_health[provider] = {
                'up': up,
                'down_seconds_remaining': max(0.0, down_seconds_remaining),
                'failures_consecutive': failures_consecutive,
                'updated_at': datetime.now(timezone.utc).isoformat(),
            }
    
    def record_feedback(self, is_fp: bool):
        """Record feedback (false positive or false negative)."""
        with self._lock:
            if is_fp:
                self.false_positives.inc()
                self._append_with_trim(self._fp_window, True)
            else:
                self.false_negatives.inc()
                self._append_with_trim(self._fn_window, True)
            
            # Update FPR and Recall
            self._update_performance_metrics()
    
    def record_evaluation_result(self, tp: int, fp: int, tn: int, fn: int):
        """Record evaluation results to update FPR and recall."""
        with self._lock:
            # Add to windows
            for _ in range(tp):
                self._append_with_trim(self._tp_window, True)
            for _ in range(fp):
                self._append_with_trim(self._fp_window, True)
            for _ in range(tn):
                self._append_with_trim(self._tn_window, True)
            for _ in range(fn):
                self._append_with_trim(self._fn_window, True)

    def _append_with_trim(self, dq: deque, value: Any):
        """Append to deque and bulk-trim oldest 10% when at capacity."""
        dq.append(value)
        if len(dq) >= self._window_max_size:
            trim = max(1, int(self._window_max_size * self._trim_fraction))
            for _ in range(trim):
                if dq:
                    dq.popleft()
            
            self._update_performance_metrics()
    
    def _update_performance_metrics(self):
        """Update FPR and Recall gauges from sliding windows."""
        fp_count = len(self._fp_window)
        fn_count = len(self._fn_window)
        tp_count = len(self._tp_window)
        tn_count = len(self._tn_window)
        
        # Calculate FPR = FP / (FP + TN)
        if fp_count + tn_count > 0:
            fpr = fp_count / (fp_count + tn_count)
            self.fpr_gauge.set(fpr)
        
        # Calculate Recall = TP / (TP + FN)
        if tp_count + fn_count > 0:
            recall = tp_count / (tp_count + fn_count)
            self.recall_gauge.set(recall)
    
    def get_current_metrics(self) -> Dict:
        """Get current metric values for CLI/stats."""
        with self._lock:
            total_reqs = self.total_requests._value.get()
            spam_count = self.spam_detected._value.get()
            ham_count = self.ham_detected._value.get()
            
            llm_reqs = self.llm_requests._value.get()
            llm_cache_hits = self.llm_cache_hits._value.get()
            llm_total = llm_reqs + llm_cache_hits
            llm_hit_rate = llm_cache_hits / llm_total if llm_total > 0 else 0.0
            
            total_cost = self.llm_cost_usd._value.get()
            
            # Latency P95
            latency_p95 = 0.0
            if len(self._latency_window) >= 20:
                latency_p95 = statistics.quantiles(self._latency_window, n=20)[18]
            
            # FPR and Recall
            fp_count = len(self._fp_window)
            tn_count = len(self._tn_window)
            tp_count = len(self._tp_window)
            fn_count = len(self._fn_window)
            
            fpr = fp_count / (fp_count + tn_count) if (fp_count + tn_count) > 0 else 0.0
            recall = tp_count / (tp_count + fn_count) if (tp_count + fn_count) > 0 else 0.0
            
            return {
                "total_requests": total_reqs,
                "spam_detected": spam_count,
                "ham_detected": ham_count,
                "latency_p95_seconds": latency_p95,
                "latency_p95_ms": latency_p95 * 1000,
                "fpr": fpr,
                "recall": recall,
                "llm_requests": llm_reqs,
                "llm_cache_hits": llm_cache_hits,
                "llm_hit_rate": llm_hit_rate,
                "llm_cost_usd": total_cost,
                "llm_daily_cost_usd": self._daily_cost,
                "llm_monthly_cost_usd": self._monthly_cost,
                "daily_budget_usd": self.daily_budget_usd,
                "monthly_budget_usd": self.monthly_budget_usd,
                "budget_warning": self._daily_cost > self.daily_budget_usd * 0.8,
                "budget_exceeded": self._daily_cost > self.daily_budget_usd,
                "provider_health": self._provider_health,
            }
    
    def check_alerts(self) -> List[Dict[str, Any]]:
        """Check for alert conditions and return list of alerts."""
        alerts = []
        
        metrics = self.get_current_metrics()
        
        # Alert: LLM cost exceeds budget
        if metrics["llm_daily_cost_usd"] > metrics["daily_budget_usd"]:
            alerts.append({
                "severity": "critical",
                "metric": "llm_cost",
                "message": f"LLM daily cost (${metrics['llm_daily_cost_usd']:.2f}) exceeds budget (${metrics['daily_budget_usd']:.2f})",
                "value": metrics["llm_daily_cost_usd"],
                "threshold": metrics["daily_budget_usd"]
            })
        elif metrics["budget_warning"]:
            alerts.append({
                "severity": "warning",
                "metric": "llm_cost",
                "message": f"LLM daily cost (${metrics['llm_daily_cost_usd']:.2f}) is above 80% of budget (${metrics['daily_budget_usd']:.2f})",
                "value": metrics["llm_daily_cost_usd"],
                "threshold": metrics["daily_budget_usd"] * 0.8
            })
        
        # Alert: FPR > 5%
        if metrics["fpr"] > 0.05:
            alerts.append({
                "severity": "critical",
                "metric": "fpr",
                "message": f"False Positive Rate ({metrics['fpr']:.1%}) exceeds 5% threshold",
                "value": metrics["fpr"],
                "threshold": 0.05
            })
        
        # Alert: LLM hit rate too low
        if metrics["llm_hit_rate"] < 0.15 and metrics["llm_requests"] > 100:
            alerts.append({
                "severity": "warning",
                "metric": "llm_hit_rate",
                "message": f"LLM cache hit rate ({metrics['llm_hit_rate']:.1%}) is below 15% target",
                "value": metrics["llm_hit_rate"],
                "threshold": 0.15
            })
        
        return alerts
    
    def set_budget(self, daily: Optional[float] = None, monthly: Optional[float] = None):
        """Set cost budgets."""
        if daily is not None:
            self.daily_budget_usd = daily
        if monthly is not None:
            self.monthly_budget_usd = monthly


# Global metrics instance
metrics_collector = MetricsCollector()

