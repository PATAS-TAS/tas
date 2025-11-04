from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, List, Dict
from app.pipeline import pipeline
from app.regex_patterns import regex_patterns
from app.config import settings
from app.rate_limit import rate_limiter
from app.ml_model import ml_model
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="TAS - Transmodal Anti-Spam API",
    description="Multi-layer transmodal spam detection: Rules → ML → LLM. Processes text, images, and other formats with unified scoring across layers.",
    version="1.0.1",
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


class ClassifyResponse(BaseModel):
    is_spam: bool
    confidence: float
    reason: str




@app.get("/")
async def root():
    return {
        "name": "TAS - Transmodal Anti-Spam API",
        "version": "1.0.1",
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
        result = await pipeline.classify(request.text, request.lang or "en")
        # Simplify response
        spam_score = result.get("spam_score", 0.0)
        confidence = result.get("confidence", 0.0)
        reasons = result.get("reasons", [])
        
        # Determine main reason
        main_reason = reasons[0] if reasons else "No specific reason"
        if len(reasons) > 1:
            main_reason = f"{reasons[0]} and {len(reasons)-1} more"
        
        return {
            "is_spam": spam_score >= 0.5,
            "confidence": round(confidence, 3),
            "reason": main_reason
        }
    except ValueError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Classification error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error. Please try again later.")


@app.post("/batch", response_model=BatchResponse)
async def batch_classify(request: BatchRequest):
    """Classify multiple texts in batch."""
    try:
        results = []
        processed = 0
        
        for text in request.texts:
            try:
                result = await pipeline.classify(text, "en")
                results.append(result)
                processed += 1
            except Exception as e:
                logger.warning(f"Error processing text: {e}")
                results.append({
                    "spam_score": 0.0,
                    "confidence": 0.0,
                    "labels": [],
                    "reasons": ["Error processing"],
                    "layers_used": [],
                    "version": pipeline.version,
                })
        
        return BatchResponse(
            results=results,
            total=len(request.texts),
            processed=processed
        )
    except Exception as e:
        logger.error(f"Batch classification error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error. Please try again later.")


@app.get("/patterns")
async def get_patterns():
    """Get list of all detection patterns."""
    patterns = []
    for pattern, reason, score in regex_patterns.patterns:
        patterns.append({
            "reason": reason,
            "score": score,
            "pattern": pattern.pattern
        })
    
    return {
        "total": len(patterns),
        "patterns": patterns
    }


@app.get("/stats")
async def get_stats():
    """Get API statistics and configuration."""
    from app.pipeline import cache
    ml_loaded = False
    if hasattr(pipeline, 'ml_model') and pipeline.ml_model:
        ml_loaded = ml_model.model is not None
    
    return {
        "version": pipeline.version,
        "thresholds": {
            "rules": settings.rules_threshold,
            "ml": settings.ml_threshold,
            "ml_safe": settings.ml_safe_threshold,
            "llm_fallback": settings.llm_fallback
        },
        "ml_model": {
            "loaded": ml_loaded,
            "name": settings.model_name
        },
        "llm_enabled": bool(settings.openai_api_key) and settings.llm_fallback,
        "cache": {
            "enabled": True,
            "size": cache.size(),
            "max_size": settings.cache_size,
            "ttl": settings.cache_ttl
        }
    }


@app.get("/health")
async def health():
    from app.pipeline import cache
    return {
        "status": "ok",
        "version": "1.0.1",
        "ml_model": "loaded" if hasattr(pipeline, 'ml_model') and pipeline.ml_model and pipeline.ml_model.model else "not_loaded",
        "llm_enabled": bool(settings.openai_api_key) and settings.llm_fallback,
        "cache_size": cache.size()
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
