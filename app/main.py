from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, List, Dict
from app.pipeline import pipeline
from app.regex_patterns import regex_patterns
from app.config import settings
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="TAS - Universal Anti-Spam API",
    description="Multi-layer spam detection service: Rules → ML → LLM",
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
    spam_score: float
    confidence: float
    labels: list[str]
    category: Optional[str] = None
    reasons: list[str]
    layers_used: list[str]
    version: str


class BatchRequest(BaseModel):
    texts: List[str] = Field(..., min_items=1, max_items=100)


class BatchResponse(BaseModel):
    results: List[Dict]
    total: int
    processed: int


@app.get("/")
async def root():
    return {
        "name": "TAS - Universal Anti-Spam API",
        "version": "1.0.1",
        "description": "Multi-layer spam detection service",
        "endpoints": {
            "classify": "/classify",
            "batch": "/batch",
            "patterns": "/patterns",
            "stats": "/stats",
            "health": "/health",
            "docs": "/docs"
        }
    }


@app.post("/classify", response_model=ClassifyResponse)
async def classify(request: ClassifyRequest):
    try:
        result = await pipeline.classify(request.text, request.lang or "en")
        return result
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
    return {
        "version": pipeline.version,
        "thresholds": {
            "rules": settings.rules_threshold,
            "ml": settings.ml_threshold,
            "llm_fallback": settings.llm_fallback
        },
        "ml_model": {
            "loaded": ml_model.model is not None if hasattr(pipeline, 'ml_model') else False,
            "name": settings.model_name
        },
        "llm_enabled": bool(settings.openai_api_key) and settings.llm_fallback
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
