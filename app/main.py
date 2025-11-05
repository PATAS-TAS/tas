from fastapi import FastAPI, HTTPException, Query, Request, Response, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from app.pipeline import pipeline
from app.config import settings
from app.rate_limit import rate_limiter
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# API versioning router
from fastapi import APIRouter
from contextlib import asynccontextmanager

v1_router = APIRouter(prefix="/v1", tags=["v1"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown events."""
    from app.llm_check import llm_check
    from app.pipeline import pipeline
    
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


app = FastAPI(
    title="TAS - Transmodal Anti-Spam API",
    description="Multi-layer transmodal spam detection: Rules → LLM. Processes text with unified scoring across layers.",
    version="1.0.3",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ClassifyRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8192)
    lang: Optional[str] = Field(default="en", max_length=10)
    sender_id: Optional[str] = Field(default=None, max_length=100)
    message_id: Optional[str] = Field(default=None, max_length=100)


class ClassifyResponse(BaseModel):
    is_spam: bool
    confidence: float
    reason: str




@app.get("/")
async def root():
    return {
        "name": "TAS - Transmodal Anti-Spam API",
        "version": "1.0.3",
        "description": "Commercial spam detection API for messengers, forums, and marketplaces.",
        "endpoints": {
            "classify": "/classify",
            "health": "/health",
            "feedback": "/feedback",
            "feedback_report": "/feedback/report",
            "docs": "/docs"
        }
    }


# v1 endpoints
@v1_router.post("/classify")
async def v1_classify(request: ClassifyRequest, client_request: Request, http_response: Response):
    # Rate limiting (100 requests per minute per IP)
    client_ip = client_request.client.host if client_request.client else "unknown"
    allowed, remaining = rate_limiter.is_allowed(client_ip, max_requests=100, window_seconds=60)
    
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded. Maximum 100 requests per minute.",
            headers={"X-RateLimit-Remaining": "0", "Retry-After": "60"}
        )
    
    rate_limiter.record_request(client_ip, "classify")
    
    # Determine LLM mode from header or config default
    llm_mode = client_request.headers.get("X-LLM-Mode", settings.llm_mode).lower()
    if llm_mode not in ["managed", "byo", "rules_only"]:
        llm_mode = "managed"
    
    # Auto-degrade: Check budget and LLM hit rate
    from app.metrics import metrics_collector
    current_metrics = metrics_collector.get_current_metrics()
    
    # Auto-degrade if budget exceeded
    if current_metrics.get("budget_exceeded", False):
        logger.warning(f"Budget exceeded, forcing rules_only mode")
        llm_mode = "rules_only"
    # Auto-degrade if LLM hit rate > 20% for extended period
    elif current_metrics.get("llm_hit_rate", 0) > 0.20:
        # Check if this has been high for 10+ minutes (simplified: check recent trend)
        logger.warning(f"LLM hit rate {current_metrics.get('llm_hit_rate', 0):.1%} > 20%, forcing rules_only")
        llm_mode = "rules_only"
    
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
            byo_api_key=byo_api_key
        )
        # Dual-format response
        spam_score = result.get("spam_score", 0.0)
        confidence = result.get("confidence", 0.0)
        reasons_raw = result.get("reasons", [])
        layers_used = result.get("layers_used", [])
        
        # Enhance reasons with code and weight
        from app.regex_patterns import regex_patterns
        reasons_enhanced = []
        for reason_text in reasons_raw[:5]:
            # Find matching pattern to get weight
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
        
        # Legacy reasons format (strings)
        reasons = reasons_raw

        # Determine main reason (legacy)
        main_reason = reasons[0] if reasons else "No specific reason"
        if len(reasons) > 1:
            main_reason = f"{reasons[0]} and {len(reasons)-1} more"

        # Derive path and request_id
        path = "llm" if "llm" in layers_used else "rules"
        import hashlib
        rid_source = request.message_id or request.text[:64]
        request_id = "r_" + hashlib.md5(rid_source.encode()).hexdigest()[:12]

        # Deprecation headers (6 months window)
        from datetime import datetime, timedelta, timezone
        sunset = (datetime.now(timezone.utc) + timedelta(days=180)).strftime("%Y-%m-%d")
        http_response.headers["Deprecation"] = "true"
        http_response.headers["Sunset"] = sunset
        # Multi-Link header (RFC 8288) for migration and LLM modes docs
        http_response.headers["Link"] = (
            "<https://kiku-jw.github.io/tas/#migration>; rel=\"deprecation\", "
            "<https://kiku-jw.github.io/tas/#modes>; rel=\"documentation\""
        )
        http_response.headers["X-TAS-Request-ID"] = request_id

        # Determine actual mode used (may differ from requested if BYO fails)
        actual_mode = result.get("llm_mode", llm_mode)
        
        return {
            # New schema
            "spam": spam_score >= settings.decision_threshold,
            "score": round(spam_score, 3),
            "reasons": reasons_enhanced,  # Enhanced with code and weight
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
        # Graceful degradation: log stacktrace and return safe response with HTTP 200
        logger.error(f"Classification error: {e}", exc_info=True)
        return {
            "is_spam": False,
            "confidence": 0.0,
            "reason": "module_error",
            "spam": False,
            "score": 0.0,
            "reasons": ["module_error"],
            "path": "rules",
            "request_id": "r_error"
        }


@v1_router.get("/health")
async def v1_health(metrics = Depends(__import__('app.deps', fromlist=['get_metrics']).get_metrics)):
    from app.pipeline import cache, pipeline
    from app.llm_check import llm_check
    from app.rol import rol
    import os
    
    llm_metrics = {}
    llm_status = "DOWN"
    if llm_check.enabled:
        llm_metrics = llm_check.get_metrics()
        provider_health = llm_metrics.get("provider_health", {})
        if provider_health.get("up", True):
            llm_status = "UP"
        elif provider_health.get("down_seconds_remaining", 0) > 0:
            llm_status = "DEGRADED"
        else:
            llm_status = "DOWN"
    
    rol_stats = {}
    ruleset_version = "1.0.3"
    if settings.enable_rol:
        rol_stats = rol.get_rule_stats()
        ruleset_version = getattr(rol, "ruleset_version", "1.0.3")
    
    build = os.getenv("BUILD_ID", os.getenv("GITHUB_SHA", "dev"))[:12]
    
    return {
        "status": "ok",
        "version": "1.0.3",
        "build": build,
        "ruleset_version": ruleset_version,
        "ml_model": "disabled",
        "llm_enabled": bool(getattr(settings, "patas_openai_api_key", "") or settings.openai_api_key) and settings.llm_fallback,
        "llm_status": llm_status,
        "cache_size": cache.size(),
        "llm_cache": llm_metrics,
        "rule_orchestrator": rol_stats
    }


@v1_router.get("/healthz")
async def v1_healthz():
    return await v1_health()


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint."""
    from prometheus_client import generate_latest, CONTENT_TYPE_LATEST
    
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )


@v1_router.get("/metrics")
async def v1_metrics():
    """Prometheus metrics endpoint (v1)."""
    from prometheus_client import generate_latest, CONTENT_TYPE_LATEST
    
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )


@app.get("/version")
async def version():
    """Get API version."""
    return {
        "version": "1.0.3",
        "api_version": "v1",
        "name": "TAS - Transmodal Anti-Spam API"
    }


@v1_router.get("/version")
async def v1_version():
    """Get API version (v1 endpoint)."""
    return {
        "version": "1.0.3",
        "api_version": "v1",
        "name": "TAS - Transmodal Anti-Spam API"
    }


# Legacy endpoints (backward compatibility)
@app.post("/classify", response_model=ClassifyResponse)
async def classify(request: ClassifyRequest, client_request: Request):
    """Legacy endpoint - use /v1/classify instead."""
    return await v1_classify(request, client_request)


@app.get("/health")
async def health():
    """Legacy endpoint - use /v1/health instead."""
    return await v1_health()


@app.get("/shadow-rules/metrics")
async def get_shadow_metrics():
    """Get shadow rules metrics (precision/recall per rule)."""
    from app.rol import rol
    
    if not settings.enable_rol:
        raise HTTPException(status_code=400, detail="Rule orchestrator is disabled")
    
    return {
        "summary": rol.get_shadow_summary(),
        "per_rule": rol.get_shadow_metrics(),
        "canary_percentage": rol.canary_percentage * 100
    }


@app.post("/shadow-rules/enable")
async def enable_shadow_rules(ruleset: Dict):
    """Enable shadow rules for testing."""
    from app.rol import rol
    
    if not settings.enable_rol:
        raise HTTPException(status_code=400, detail="Rule orchestrator is disabled")
    
    rol.enable_shadow_rules(ruleset)
    return {"status": "enabled", "rules_count": len(rol.shadow_patterns)}


@app.post("/shadow-rules/canary")
async def set_canary_percentage(percentage: float = Query(..., ge=0.0, le=1.0)):
    """Set canary rollout percentage (0.0-1.0)."""
    from app.rol import rol
    
    if not settings.enable_rol:
        raise HTTPException(status_code=400, detail="Rule orchestrator is disabled")
    
    rol.set_canary_percentage(percentage)
    return {"canary_percentage": percentage * 100}


class ShadowRuleFeedback(BaseModel):
    rule_id: str
    predicted_spam: bool
    actual_spam: bool


@app.post("/shadow-rules/feedback")
async def record_shadow_feedback(feedback: ShadowRuleFeedback):
    """Record feedback for shadow rule (for metrics calculation)."""
    from app.rol import rol
    
    if not settings.enable_rol:
        raise HTTPException(status_code=400, detail="Rule orchestrator is disabled")
    
    rol.record_shadow_result(
        feedback.rule_id,
        feedback.predicted_spam,
        feedback.actual_spam
    )
    return {"status": "recorded", "rule_id": feedback.rule_id}


class FeedbackRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8192)
    predicted_spam: bool = Field(..., description="What TAS predicted")
    actual_spam: bool = Field(..., description="What it actually was")
    sender_id: Optional[str] = Field(default=None, max_length=100)
    message_id: Optional[str] = Field(default=None, max_length=100)
    lang: Optional[str] = Field(default=None, max_length=10)
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="Additional metadata")


from app.deps import get_feedback_db


@app.post("/feedback")
async def submit_feedback(feedback: FeedbackRequest, feedback_db = Depends(get_feedback_db)):
    """
    Submit feedback for FP/FN examples from production.
    
    This endpoint allows production systems to report false positives (FP) or false negatives (FN).
    Feedback is stored in a database and used to generate reports on rule performance.
    """
    try:
        # Get the original classification result to extract reasons and matched rules
        result = await pipeline.classify(
            feedback.text,
            feedback.lang or "en",
            sender_id=feedback.sender_id,
            message_id=feedback.message_id
        )
        
        spam_score = result.get("spam_score", 0.0)
        confidence = result.get("confidence", 0.0)
        reasons = result.get("reasons", [])
        
        # Extract matched rule names from reasons
        # Reasons format: "Reason name" or "Reason name and X more"
        matched_rules = []
        for reason in reasons:
            # Clean up reason strings to extract rule names
            rule_name = reason.split(" and ")[0].strip()
            matched_rules.append(rule_name)
        
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
        from app.metrics import metrics_collector
        is_fp = feedback.predicted_spam and not feedback.actual_spam
        metrics_collector.record_feedback(is_fp=is_fp)
        
        error_type = "FP" if (feedback.predicted_spam and not feedback.actual_spam) else "FN"
        
        return {
            "status": "recorded",
            "feedback_id": feedback_id,
            "error_type": error_type,
            "message": f"{error_type} feedback recorded successfully"
        }
    except Exception as e:
        logger.error(f"Error recording feedback: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to record feedback: {str(e)}")


@app.get("/feedback/report")
async def get_feedback_report(format: Optional[str] = Query("json", pattern="^(json|html)$")):
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
        # Generate HTML report file
        report_file = generate_html_report()
        return {
            "status": "generated",
            "report_file": str(report_file),
            "message": "HTML report generated successfully"
        }
    
    # JSON response
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
):
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


# Batch classification
@v1_router.post("/batch")
async def v1_batch(requests: List[ClassifyRequest], client_request: Request):
    from fastapi import Response as FastAPIResponse
    
    # Note: Payload size cap (256 KB) should be enforced at load balancer/nginx level
    # FastAPI body parsing happens before this function, so we validate counts/sizes here
    
    if len(requests) == 0:
        return []
    if len(requests) > 100:
        raise HTTPException(status_code=400, detail="Too many items (limit 100)")

    # Per-item validation: text length <= 2000
    for i, item in enumerate(requests):
        if len(item.text) > 2000:
            raise HTTPException(status_code=400, detail=f"Item {i} text too long (limit 2000 chars)")

    results = []
    for item in requests:
        # Create a Response object for each item to collect headers
        http_response = FastAPIResponse()
        res = await v1_classify(item, client_request, http_response)
        results.append(res)
    return results


def _generate_recommendations(rule_stats: Dict[str, Dict[str, Any]]) -> List[str]:
    """Generate recommendations based on rule statistics."""
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
    
    return recommendations[:10]  # Limit to top 10


# Include v1 router
app.include_router(v1_router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
