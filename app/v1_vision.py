"""
Vision/Image analysis endpoint for transmodal spam detection.
"""

from fastapi import APIRouter, UploadFile, File, HTTPException, Request
from pydantic import BaseModel, Field
from typing import Optional
import logging
from app.pipeline import pipeline
from app.config import settings

logger = logging.getLogger(__name__)

v1_vision_router = APIRouter(prefix="/v1", tags=["vision"])


class VisionClassifyRequest(BaseModel):
    """Request for vision-based classification."""
    image_url: Optional[str] = Field(None, description="URL to image")
    text: Optional[str] = Field(None, description="Optional accompanying text")
    lang: Optional[str] = Field("en", pattern="^(en|ru|es|fr|ar|zh)$")
    sender_id: Optional[str] = None
    message_id: Optional[str] = None


@v1_vision_router.post("/classify/image")
async def v1_classify_image(
    request: VisionClassifyRequest,
    client_request: Request
):
    """
    Classify image for commercial spam.
    
    Supports:
    - image_url: URL to image (fetched by model)
    - Optional text: Accompanying text message
    
    Returns same format as /classify but with vision analysis.
    """
    if not settings.vision_enabled:
        raise HTTPException(
            status_code=503,
            detail="Vision analysis is disabled. Set VISION_ENABLED=true and OPENROUTER_API_KEY"
        )
    
    if not request.image_url:
        raise HTTPException(
            status_code=400,
            detail="image_url is required"
        )
    
    text = request.text or ""
    
    try:
        result = await pipeline.classify(
            text=text,
            lang=request.lang or "en",
            sender_id=request.sender_id,
            message_id=request.message_id,
            llm_mode="rules_only",  # Vision handles image, rules handle text
            image_url=request.image_url
        )
        
        # Add vision-specific fields
        if "vision" in result.get("layers_used", []):
            result["has_image_analysis"] = True
        else:
            result["has_image_analysis"] = False
        
        return result
    except Exception as e:
        logger.error(f"Vision classification error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Vision classification failed: {str(e)}"
        )


@v1_vision_router.post("/classify/image/upload")
async def v1_classify_image_upload(
    image: UploadFile = File(...),
    text: Optional[str] = None,
    lang: Optional[str] = "en",
    sender_id: Optional[str] = None,
    message_id: Optional[str] = None
):
    """
    Classify uploaded image for commercial spam.
    
    Accepts image file upload and optional text.
    """
    if not settings.vision_enabled:
        raise HTTPException(
            status_code=503,
            detail="Vision analysis is disabled"
        )
    
    # Validate image type
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(
            status_code=400,
            detail="File must be an image (JPEG, PNG, etc.)"
        )
    
    # Read image bytes
    image_bytes = await image.read()
    
    # Limit size (e.g., 10MB)
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail="Image too large (max 10MB)"
        )
    
    try:
        result = await pipeline.classify(
            text=text or "",
            lang=lang or "en",
            sender_id=sender_id,
            message_id=message_id,
            llm_mode="rules_only",
            image_bytes=image_bytes
        )
        
        if "vision" in result.get("layers_used", []):
            result["has_image_analysis"] = True
        else:
            result["has_image_analysis"] = False
        
        return result
    except Exception as e:
        logger.error(f"Vision upload classification error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Vision classification failed: {str(e)}"
        )

