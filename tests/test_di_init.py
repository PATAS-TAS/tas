"""
Tests for FastAPI dependency injection lazy initialization and no shared state.
"""
import pytest
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient

from app.deps import get_metrics, get_cache, get_feedback_db
from app.metrics import MetricsCollector
from app.cache import ClassificationCache
from app.feedback_db import FeedbackDB


def build_app(include_metrics: bool = True):
    app = FastAPI()

    if include_metrics:
        @app.get("/ids")
        def ids(metrics: MetricsCollector = Depends(get_metrics),
                cache: ClassificationCache = Depends(get_cache),
                fb: FeedbackDB = Depends(get_feedback_db)):
            return {
                "metrics_id": id(metrics),
                "cache_id": id(cache),
                "feedback_id": id(fb),
            }
    else:
        @app.get("/ids")
        def ids(cache: ClassificationCache = Depends(get_cache),
                fb: FeedbackDB = Depends(get_feedback_db)):
            return {
                "cache_id": id(cache),
                "feedback_id": id(fb),
            }

    return app


def test_lazy_init_and_per_app_instances_without_metrics():
    app1 = build_app(include_metrics=False)
    app2 = build_app(include_metrics=False)

    c1 = TestClient(app1)
    c2 = TestClient(app2)

    r1a = c1.get("/ids").json()
    r1b = c1.get("/ids").json()
    r2a = c2.get("/ids").json()

    # Lazy init: instances exist and are stable within same app
    assert r1a["cache_id"] == r1b["cache_id"]
    assert r1a["feedback_id"] == r1b["feedback_id"]

    # No shared state between app1 and app2
    assert r1a["cache_id"] != r2a["cache_id"]
    assert r1a["feedback_id"] != r2a["feedback_id"]


def test_metrics_lazy_init_single_app():
    app = build_app(include_metrics=True)
    c = TestClient(app)
    a = c.get("/ids").json()
    b = c.get("/ids").json()
    assert a["metrics_id"] == b["metrics_id"]


