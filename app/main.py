"""
TAS - Transmodal Anti-Spam API.

Main FastAPI application module providing REST API endpoints for spam classification.
"""
import hashlib
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app.config import settings
from app.constants import (
    API_VERSION,
    AUTO_DEGRADE_LLM_HIT_RATE,
    DEFAULT_RATE_LIMIT_REQUESTS,
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    MAX_RESPONSE_REASONS,
)
from app.deps import get_feedback_db
from app.feedback_db import FeedbackDB
from app.llm_check import llm_check
from app.metrics import metrics_collector
from app.pipeline import cache, pipeline
from app.rate_limit import rate_limiter
from app.regex_patterns import regex_patterns
from app.rol import rol
from app.v1_vision import v1_vision_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# API versioning router
v1_router = APIRouter(prefix="/v1", tags=["v1"])


# =============================================================================
# Request/Response Models
# =============================================================================


class ClassifyRequest(BaseModel):
    """Request model for text classification."""

    text: str = Field(..., min_length=1, max_length=8192, description="Text to classify")
    lang: Optional[str] = Field(default="en", max_length=10, description="Language code")
    sender_id: Optional[str] = Field(default=None, max_length=100, description="Sender ID")
    message_id: Optional[str] = Field(default=None, max_length=100, description="Message ID")
    image_url: Optional[str] = Field(
        default=None, description="URL to image for vision analysis"
    )


class ClassifyResponse(BaseModel):
    """Response model for text classification (legacy format)."""

    is_spam: bool
    confidence: float
    reason: str


class ShadowRuleFeedback(BaseModel):
    """Feedback for shadow rule testing."""

    rule_id: str
    predicted_spam: bool
    actual_spam: bool


class FeedbackRequest(BaseModel):
    """Request model for submitting feedback."""

    text: str = Field(..., min_length=1, max_length=8192)
    predicted_spam: bool = Field(..., description="What TAS predicted")
    actual_spam: bool = Field(..., description="What it actually was")
    sender_id: Optional[str] = Field(default=None, max_length=100)
    message_id: Optional[str] = Field(default=None, max_length=100)
    lang: Optional[str] = Field(default=None, max_length=10)
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="Additional metadata")


# =============================================================================
# Lifespan Management
# =============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Lifespan context manager for startup/shutdown events.

    Handles:
    - LLM connection warm-up
    - Rules pre-loading
    """
    logger.info("Starting up TAS API...")

    # Warm-up LLM connection if enabled
    if llm_check.enabled:
        logger.info("Warming up LLM connection...")
        await llm_check.warmup()

    # Pre-load rules if ROL is enabled
    if settings.enable_rol:
        try:
            await pipeline._ensure_rules_loaded()
            logger.info("Rules pre-loaded successfully")
        except Exception as e:
            logger.warning(f"Rules pre-load failed: {e}")

    logger.info("TAS API ready")

    yield

    logger.info("Shutting down TAS API...")


# =============================================================================
# FastAPI Application
# =============================================================================

app = FastAPI(
    title="TAS - Transmodal Anti-Spam API",
    description="Multi-layer transmodal spam detection: Rules → LLM. "
    "Processes text with unified scoring across layers.",
    version=API_VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# Helper Functions
# =============================================================================


def _determine_llm_mode(request: Request) -> str:
    """
    Determine LLM mode from request headers and auto-degrade if needed.

    Args:
        request: FastAPI request object

    Returns:
        LLM mode string: "managed", "byo", or "rules_only"
    """
    llm_mode = request.headers.get("X-LLM-Mode", settings.llm_mode).lower()
    if llm_mode not in ["managed", "byo", "rules_only"]:
        llm_mode = "managed"

    # Auto-degrade: Check budget and LLM hit rate
    current_metrics = metrics_collector.get_current_metrics()

    # Auto-degrade if budget exceeded
    if current_metrics.get("budget_exceeded", False):
        logger.warning("Budget exceeded, forcing rules_only mode")
        return "rules_only"

    # Auto-degrade if LLM hit rate > 20%
    if current_metrics.get("llm_hit_rate", 0) > AUTO_DEGRADE_LLM_HIT_RATE:
        logger.warning(
            f"LLM hit rate {current_metrics.get('llm_hit_rate', 0):.1%} > 20%, "
            "forcing rules_only"
        )
        return "rules_only"

    return llm_mode


def _enhance_reasons(reasons_raw: List[str]) -> List[Dict[str, Any]]:
    """
    Enhance reason strings with code and weight.

    Args:
        reasons_raw: List of reason strings

    Returns:
        List of enhanced reason dictionaries
    """
    reasons_enhanced = []
    for reason_text in reasons_raw[:MAX_RESPONSE_REASONS]:
        weight = 0.0
        code = reason_text.lower().replace(" ", "_").replace("-", "_")
        for pattern, name, pattern_weight in regex_patterns.patterns:
            if name == reason_text:
                weight = pattern_weight
                code = name.lower().replace(" ", "_").replace("-", "_")
                break
        reasons_enhanced.append({
            "code": code,
            "text": reason_text,
            "weight": round(weight, 3)
        })
    return reasons_enhanced


def _generate_request_id(message_id: Optional[str], text: str) -> str:
    """
    Generate unique request ID.

    Args:
        message_id: Optional message identifier
        text: Request text

    Returns:
        Request ID string
    """
    rid_source = message_id or text[:64]
    return "r_" + hashlib.md5(rid_source.encode()).hexdigest()[:12]


def _add_deprecation_headers(response: Response, request_id: str) -> None:
    """
    Add deprecation headers to response.

    Args:
        response: FastAPI Response object
        request_id: Request ID string
    """
    sunset = (datetime.now(timezone.utc) + timedelta(days=180)).strftime("%Y-%m-%d")
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = sunset
    response.headers["Link"] = (
        '<https://kiku-jw.github.io/tas/#migration>; rel="deprecation", '
        '<https://kiku-jw.github.io/tas/#modes>; rel="documentation"'
    )
    response.headers["X-TAS-Request-ID"] = request_id


def _generate_recommendations(rule_stats: Dict[str, Dict[str, Any]]) -> List[str]:
    """
    Generate recommendations based on rule statistics.

    Args:
        rule_stats: Dictionary of rule statistics

    Returns:
        List of recommendation strings
    """
    recommendations = []

    for rule_name, stats in rule_stats.items():
        fpr = stats.get("false_positive_rate", 0.0)
        fp_count = stats.get("false_positives", 0)
        fn_count = stats.get("false_negatives", 0)

        if fpr > 0.10 and fp_count >= 5:
            recommendations.append(
                f"Rule '{rule_name}' has high FPR ({fpr:.1%}) with {fp_count} FPs. "
                f"Consider refining the pattern or adding negative context checks."
            )

        if fn_count >= 10:
            recommendations.append(
                f"Rule '{rule_name}' has {fn_count} false negatives. "
                f"Consider expanding the pattern or lowering the score threshold."
            )

    return recommendations[:10]


# =============================================================================
# Root Endpoint
# =============================================================================


@app.get("/")
async def root() -> Dict[str, Any]:
    """Get API information."""
    return {
        "name": "TAS - Transmodal Anti-Spam API",
        "version": API_VERSION,
        "description": "Commercial spam detection API for messengers, forums, and marketplaces.",
        "endpoints": {
            "classify": "/classify",
            "health": "/health",
            "feedback": "/feedback",
            "feedback_report": "/feedback/report",
            "docs": "/docs"
        }
    }


# =============================================================================
# V1 Classification Endpoints
# =============================================================================


@v1_router.post("/classify")
async def v1_classify(
    request: ClassifyRequest,
    client_request: Request,
    http_response: Response
) -> Dict[str, Any]:
    """
    Classify text for spam.

    Args:
        request: Classification request
        client_request: FastAPI request object
        http_response: FastAPI response object

    Returns:
        Classification result with spam score and reasons
    """
    # Rate limiting
    client_ip = client_request.client.host if client_request.client else "unknown"
    allowed, _ = rate_limiter.is_allowed(
        client_ip,
        max_requests=DEFAULT_RATE_LIMIT_REQUESTS,
        window_seconds=DEFAULT_RATE_LIMIT_WINDOW_SECONDS
    )

    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Maximum 100 requests per minute.",
            headers={"X-RateLimit-Remaining": "0", "Retry-After": "60"}
        )

    rate_limiter.record_request(client_ip, "classify")

    # Determine LLM mode
    llm_mode = _determine_llm_mode(client_request)

    # Extract BYO credentials if provided
    byo_provider = client_request.headers.get("X-LLM-Provider")
    byo_api_key = client_request.headers.get("X-LLM-Key")

    # BYO mode requires provider and key
    if llm_mode == "byo" and (not byo_provider or not byo_api_key):
        raise HTTPException(
            status_code=400,
            detail="BYO mode requires X-LLM-Provider and X-LLM-Key headers"
        )

    try:
        result = await pipeline.classify(
            request.text,
            request.lang or "en",
            sender_id=request.sender_id,
            message_id=request.message_id,
            llm_mode=llm_mode,
            byo_provider=byo_provider,
            byo_api_key=byo_api_key,
            image_url=request.image_url
        )

        spam_score = result.get("spam_score", 0.0)
        confidence = result.get("confidence", 0.0)
        reasons_raw = result.get("reasons", [])
        layers_used = result.get("layers_used", [])

        # Enhance reasons
        reasons_enhanced = _enhance_reasons(reasons_raw)

        # Determine main reason (legacy)
        main_reason = reasons_raw[0] if reasons_raw else "No specific reason"
        if len(reasons_raw) > 1:
            main_reason = f"{reasons_raw[0]} and {len(reasons_raw) - 1} more"

        # Generate request ID and path
        path = "llm" if "llm" in layers_used else "rules"
        request_id = _generate_request_id(request.message_id, request.text)

        # Add deprecation headers
        _add_deprecation_headers(http_response, request_id)

        # Determine actual mode used
        actual_mode = result.get("llm_mode", llm_mode)

        return {
            # New schema
            "spam": spam_score >= settings.decision_threshold,
            "score": round(spam_score, 3),
            "reasons": reasons_enhanced,
            "path": path,
            "mode": actual_mode,
            "request_id": request_id,
            # Legacy fields (back-compat)
            "is_spam": spam_score >= settings.decision_threshold,
            "confidence": round(confidence, 3),
            "reason": main_reason,
        }
    except ValueError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Classification error: {e}", exc_info=True)
        return {
            "is_spam": False,
            "confidence": 0.0,
            "reason": "module_error",
            "spam": False,
            "score": 0.0,
            "reasons": [{"code": "module_error", "text": "module_error", "weight": 0.0}],
            "path": "rules",
            "request_id": "r_error"
        }


@v1_router.post("/batch")
async def v1_batch(
    requests: List[ClassifyRequest],
    client_request: Request
) -> List[Dict[str, Any]]:
    """
    Batch classification endpoint.

    Args:
        requests: List of classification requests
        client_request: FastAPI request object

    Returns:
        List of classification results
    """
    if len(requests) == 0:
        return []
    if len(requests) > 100:
        raise HTTPException(status_code=400, detail="Too many items (limit 100)")

    # Per-item validation
    for i, item in enumerate(requests):
        if len(item.text) > 2000:
            raise HTTPException(
                status_code=400,
                detail=f"Item {i} text too long (limit 2000 chars)"
            )

    results = []
    for item in requests:
        http_response = Response()
        res = await v1_classify(item, client_request, http_response)
        results.append(res)
    return results


# =============================================================================
# Health Endpoints
# =============================================================================


@v1_router.get("/health")
async def v1_health() -> Dict[str, Any]:
    """
    Get API health status.

    Returns:
        Health status with component information
    """
    llm_metrics: Dict[str, Any] = {}
    llm_status = "DOWN"
    if llm_check.enabled:
        llm_metrics = llm_check.get_metrics()
        provider_health = llm_metrics.get("provider_health", {})
        if provider_health.get("up", True):
            llm_status = "UP"
        elif provider_health.get("down_seconds_remaining", 0) > 0:
            llm_status = "DEGRADED"

    rol_stats: Dict[str, Any] = {}
    ruleset_version = API_VERSION
    if settings.enable_rol:
        rol_stats = rol.get_rule_stats()
        ruleset_version = getattr(rol, "ruleset_version", API_VERSION)

    build = os.getenv("BUILD_ID", os.getenv("GITHUB_SHA", "dev"))[:12]

    return {
        "status": "ok",
        "version": API_VERSION,
        "build": build,
        "ruleset_version": ruleset_version,
        "ml_model": "disabled",
        "llm_enabled": bool(
            getattr(settings, "patas_openai_api_key", "") or settings.openai_api_key
        ) and settings.llm_fallback,
        "llm_status": llm_status,
        "cache_size": cache.size(),
        "llm_cache": llm_metrics,
        "rule_orchestrator": rol_stats
    }


@v1_router.get("/healthz")
async def v1_healthz() -> Dict[str, Any]:
    """Kubernetes-style health check."""
    return await v1_health()


# =============================================================================
# Metrics Endpoints
# =============================================================================


@app.get("/metrics")
async def metrics() -> Response:
    """Prometheus metrics endpoint."""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )


@v1_router.get("/metrics")
async def v1_metrics() -> Response:
    """Prometheus metrics endpoint (v1)."""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )


# =============================================================================
# Version Endpoints
# =============================================================================


@app.get("/version")
async def version() -> Dict[str, str]:
    """Get API version."""
    return {
        "version": API_VERSION,
        "api_version": "v1",
        "name": "TAS - Transmodal Anti-Spam API"
    }


@v1_router.get("/version")
async def v1_version() -> Dict[str, str]:
    """Get API version (v1 endpoint)."""
    return {
        "version": API_VERSION,
        "api_version": "v1",
        "name": "TAS - Transmodal Anti-Spam API"
    }


# =============================================================================
# Legacy Endpoints (Backward Compatibility)
# =============================================================================


@app.post("/classify", response_model=ClassifyResponse)
async def classify(request: ClassifyRequest, client_request: Request) -> Dict[str, Any]:
    """Legacy endpoint - use /v1/classify instead."""
    http_response = Response()
    return await v1_classify(request, client_request, http_response)


@app.get("/health")
async def health() -> Dict[str, Any]:
    """Legacy endpoint - use /v1/health instead."""
    return await v1_health()


# =============================================================================
# Shadow Rules Endpoints
# =============================================================================


@app.get("/shadow-rules/metrics")
async def get_shadow_metrics() -> Dict[str, Any]:
    """Get shadow rules metrics (precision/recall per rule)."""
    if not settings.enable_rol:
        raise HTTPException(status_code=400, detail="Rule orchestrator is disabled")

    return {
        "summary": rol.get_shadow_summary(),
        "per_rule": rol.get_shadow_metrics(),
        "canary_percentage": rol.canary_percentage * 100
    }


@app.post("/shadow-rules/enable")
async def enable_shadow_rules(ruleset: Dict[str, Any]) -> Dict[str, Any]:
    """Enable shadow rules for testing."""
    if not settings.enable_rol:
        raise HTTPException(status_code=400, detail="Rule orchestrator is disabled")

    rol.enable_shadow_rules(ruleset)
    return {"status": "enabled", "rules_count": len(rol.shadow_patterns)}


@app.post("/shadow-rules/canary")
async def set_canary_percentage(
    percentage: float = Query(..., ge=0.0, le=1.0)
) -> Dict[str, float]:
    """Set canary rollout percentage (0.0-1.0)."""
    if not settings.enable_rol:
        raise HTTPException(status_code=400, detail="Rule orchestrator is disabled")

    rol.set_canary_percentage(percentage)
    return {"canary_percentage": percentage * 100}


@app.post("/shadow-rules/feedback")
async def record_shadow_feedback(feedback: ShadowRuleFeedback) -> Dict[str, str]:
    """Record feedback for shadow rule (for metrics calculation)."""
    if not settings.enable_rol:
        raise HTTPException(status_code=400, detail="Rule orchestrator is disabled")

    rol.record_shadow_result(
        feedback.rule_id,
        feedback.predicted_spam,
        feedback.actual_spam
    )
    return {"status": "recorded", "rule_id": feedback.rule_id}


# =============================================================================
# Feedback Endpoints
# =============================================================================


@app.post("/feedback")
async def submit_feedback(
    feedback: FeedbackRequest,
    feedback_db: FeedbackDB = Depends(get_feedback_db)
) -> Dict[str, Any]:
    """
    Submit feedback for FP/FN examples from production.

    This endpoint allows production systems to report false positives (FP)
    or false negatives (FN). Feedback is stored in a database and used
    to generate reports on rule performance.
    """
    try:
        result = await pipeline.classify(
            feedback.text,
            feedback.lang or "en",
            sender_id=feedback.sender_id,
            message_id=feedback.message_id
        )

        spam_score = result.get("spam_score", 0.0)
        confidence = result.get("confidence", 0.0)
        reasons = result.get("reasons", [])

        # Extract matched rule names
        matched_rules = [reason.split(" and ")[0].strip() for reason in reasons]

        # Add feedback to database
        feedback_id = feedback_db.add_feedback(
            text=feedback.text,
            predicted_spam=feedback.predicted_spam,
            actual_spam=feedback.actual_spam,
            spam_score=spam_score,
            confidence=confidence,
            reasons=reasons,
            matched_rules=matched_rules,
            sender_id=feedback.sender_id,
            message_id=feedback.message_id,
            lang=feedback.lang,
            metadata=feedback.metadata
        )

        # Record feedback in metrics
        is_fp = feedback.predicted_spam and not feedback.actual_spam
        metrics_collector.record_feedback(is_fp=is_fp)

        error_type = "FP" if is_fp else "FN"

        return {
            "status": "recorded",
            "feedback_id": feedback_id,
            "error_type": error_type,
            "message": f"{error_type} feedback recorded successfully"
        }
    except Exception as e:
        logger.error(f"Error recording feedback: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to record feedback: {str(e)}"
        )


@app.get("/feedback/report")
async def get_feedback_report(
    format: Optional[str] = Query("json", pattern="^(json|html)$")
) -> Dict[str, Any]:
    """
    Get feedback report showing FP/FN per rule.

    Formats:
    - json: JSON API response
    - html: Generate and save HTML report file
    """
    from app.feedback_db import feedback_db
    from app.feedback_reporter import generate_html_report

    rule_stats = feedback_db.get_rule_stats()
    summary = feedback_db.get_summary()

    if format == "html":
        report_file = generate_html_report()
        return {
            "status": "generated",
            "report_file": str(report_file),
            "message": "HTML report generated successfully"
        }

    return {
        "summary": summary,
        "per_rule": rule_stats,
        "recommendations": _generate_recommendations(rule_stats)
    }


@app.get("/feedback/entries")
async def get_feedback_entries(
    error_type: Optional[str] = Query(None, pattern="^(fp|fn)$"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0)
) -> Dict[str, Any]:
    """Get feedback entries (FP or FN examples)."""
    from app.feedback_db import feedback_db

    entries = feedback_db.get_feedback(
        error_type=error_type,
        limit=limit,
        offset=offset
    )

    return {
        "entries": entries,
        "count": len(entries),
        "limit": limit,
        "offset": offset
    }


# =============================================================================
# Router Registration
# =============================================================================

app.include_router(v1_router)
app.include_router(v1_vision_router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
