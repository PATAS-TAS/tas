"""
Dependency injection container for TAS application.

This module provides FastAPI dependencies for all major components,
enabling proper dependency injection and easier testing.
"""
from fastapi import Request
from typing import TYPE_CHECKING

from app.metrics import MetricsCollector, metrics_collector
from app.cache import ClassificationCache
from app.config import settings
from app.feedback_db import FeedbackDB

if TYPE_CHECKING:
    from app.pipeline import MultiLayerPipeline
    from app.llm_check import LLMCheck
    from app.rrs import ReputationRateSentinel
    from app.lur import LinkURLRisk
    from app.sig import SignatureChecker
    from app.rol import RuleOrchestrator
    from app.qzn import Quarantine


def get_metrics(request: Request) -> MetricsCollector:
    """
    Get the metrics collector instance.

    Uses process-wide singleton to avoid Prometheus duplicate registry errors.

    Args:
        request: FastAPI request object

    Returns:
        MetricsCollector instance
    """
    if not hasattr(request.app.state, "metrics") or request.app.state.metrics is None:
        request.app.state.metrics = metrics_collector
    return request.app.state.metrics


def get_cache(request: Request) -> ClassificationCache:
    """
    Get the classification cache instance.

    Args:
        request: FastAPI request object

    Returns:
        ClassificationCache instance
    """
    if not hasattr(request.app.state, "cache") or request.app.state.cache is None:
        request.app.state.cache = ClassificationCache(
            max_size=settings.cache_size,
            ttl=settings.cache_ttl,
        )
    return request.app.state.cache


def get_feedback_db(request: Request) -> FeedbackDB:
    """
    Get the feedback database instance.

    Args:
        request: FastAPI request object

    Returns:
        FeedbackDB instance
    """
    if not hasattr(request.app.state, "feedback_db") or request.app.state.feedback_db is None:
        request.app.state.feedback_db = FeedbackDB()
    return request.app.state.feedback_db


def get_pipeline(request: Request) -> "MultiLayerPipeline":
    """
    Get the classification pipeline instance.

    Args:
        request: FastAPI request object

    Returns:
        MultiLayerPipeline instance
    """
    if not hasattr(request.app.state, "pipeline") or request.app.state.pipeline is None:
        from app.pipeline import pipeline
        request.app.state.pipeline = pipeline
    return request.app.state.pipeline


def get_llm_check(request: Request) -> "LLMCheck":
    """
    Get the LLM check instance.

    Args:
        request: FastAPI request object

    Returns:
        LLMCheck instance
    """
    if not hasattr(request.app.state, "llm_check") or request.app.state.llm_check is None:
        from app.llm_check import llm_check
        request.app.state.llm_check = llm_check
    return request.app.state.llm_check


def get_rrs(request: Request) -> "ReputationRateSentinel":
    """
    Get the Reputation Rate Sentinel instance.

    Args:
        request: FastAPI request object

    Returns:
        ReputationRateSentinel instance
    """
    if not hasattr(request.app.state, "rrs") or request.app.state.rrs is None:
        from app.rrs import rrs
        request.app.state.rrs = rrs
    return request.app.state.rrs


def get_lur(request: Request) -> "LinkURLRisk":
    """
    Get the Link URL Risk checker instance.

    Args:
        request: FastAPI request object

    Returns:
        LinkURLRisk instance
    """
    if not hasattr(request.app.state, "lur") or request.app.state.lur is None:
        from app.lur import lur
        request.app.state.lur = lur
    return request.app.state.lur


def get_sig(request: Request) -> "SignatureChecker":
    """
    Get the Signature Checker instance.

    Args:
        request: FastAPI request object

    Returns:
        SignatureChecker instance
    """
    if not hasattr(request.app.state, "sig") or request.app.state.sig is None:
        from app.sig import sig
        request.app.state.sig = sig
    return request.app.state.sig


def get_rol(request: Request) -> "RuleOrchestrator":
    """
    Get the Rule Orchestrator instance.

    Args:
        request: FastAPI request object

    Returns:
        RuleOrchestrator instance
    """
    if not hasattr(request.app.state, "rol") or request.app.state.rol is None:
        from app.rol import rol
        request.app.state.rol = rol
    return request.app.state.rol


def get_qzn(request: Request) -> "Quarantine":
    """
    Get the Quarantine instance.

    Args:
        request: FastAPI request object

    Returns:
        Quarantine instance
    """
    if not hasattr(request.app.state, "qzn") or request.app.state.qzn is None:
        from app.qzn import qzn
        request.app.state.qzn = qzn
    return request.app.state.qzn


