from fastapi import Request
from typing import Optional

from app.metrics import MetricsCollector, metrics_collector
from app.cache import ClassificationCache
from app.config import settings
from app.feedback_db import FeedbackDB


def get_metrics(request: Request) -> MetricsCollector:
    # Use process-wide singleton to avoid Prometheus duplicate registry errors
    if not hasattr(request.app.state, "metrics") or request.app.state.metrics is None:
        request.app.state.metrics = metrics_collector
    return request.app.state.metrics


def get_cache(request: Request) -> ClassificationCache:
    if not hasattr(request.app.state, "cache") or request.app.state.cache is None:
        request.app.state.cache = ClassificationCache(
            max_size=settings.cache_size,
            ttl=settings.cache_ttl,
        )
    return request.app.state.cache


def get_feedback_db(request: Request) -> FeedbackDB:
    if not hasattr(request.app.state, "feedback_db") or request.app.state.feedback_db is None:
        request.app.state.feedback_db = FeedbackDB()
    return request.app.state.feedback_db


