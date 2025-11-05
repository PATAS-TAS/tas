from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, List, Dict
from app.pipeline import pipeline
from app.config import settings
from app.rate_limit import rate_limiter
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="TAS - Transmodal Anti-Spam API",
    description="Multi-layer transmodal spam detection: Rules → LLM. Processes text with unified scoring across layers.",
    version="1.0.2",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    """Warm-up connections and pre-initialize components on startup."""
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
            "docs": "/docs"
        }
    }


@app.post("/classify", response_model=ClassifyResponse)
async def classify(request: ClassifyRequest, client_request: Request):
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
    
    try:
        result = await pipeline.classify(
            request.text, 
            request.lang or "en",
            sender_id=request.sender_id,
            message_id=request.message_id
        )
        # Simplify response
        spam_score = result.get("spam_score", 0.0)
        confidence = result.get("confidence", 0.0)
        reasons = result.get("reasons", [])
        
        # Determine main reason
        main_reason = reasons[0] if reasons else "No specific reason"
        if len(reasons) > 1:
            main_reason = f"{reasons[0]} and {len(reasons)-1} more"
        
        return {
            "is_spam": spam_score >= settings.decision_threshold,
            "confidence": round(confidence, 3),
            "reason": main_reason
        }
    except ValueError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Classification error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error. Please try again later.")


@app.get("/health")
async def health():
    from app.pipeline import cache
    from app.llm_check import llm_check
    from app.rol import rol
    
    llm_metrics = {}
    if llm_check.enabled:
        llm_metrics = llm_check.get_metrics()
    
    rol_stats = {}
    if settings.enable_rol:
        rol_stats = rol.get_rule_stats()
    
    return {
        "status": "ok",
        "version": "1.0.3",
        "ml_model": "disabled",
        "llm_enabled": bool(getattr(settings, "patas_openai_api_key", "") or settings.openai_api_key) and settings.llm_fallback,
        "cache_size": cache.size(),
        "llm_cache": llm_metrics,
        "rule_orchestrator": rol_stats
    }


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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
