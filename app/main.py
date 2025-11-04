from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional
from app.pipeline import pipeline
from app.config import settings
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="TAS - Universal Anti-Spam API",
    description="Multi-layer spam detection service: Rules → ML → LLM",
    version="1.0.0",
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
    reasons: list[str]
    layers_used: list[str]
    version: str


@app.get("/")
async def root():
    return {
        "name": "TAS - Universal Anti-Spam API",
        "version": "1.0.0",
        "description": "Multi-layer spam detection service",
        "endpoints": {
            "classify": "/classify",
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


@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

