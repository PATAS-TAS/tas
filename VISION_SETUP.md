# Vision/Transmodal Setup Guide

**Status**: ✅ **READY**

## Overview

TAS now supports **transmodal spam detection** - analyzing images for commercial spam text using OpenRouter vision models.

## Supported Models

### Recommended: `openai/gpt-4o-mini`
- **Cost**: ~$0.15 per 1M input tokens (very cheap)
- **Quality**: Excellent text recognition (OCR)
- **Speed**: Fast (~1-2s per image)
- **Best for**: Commercial spam detection in images

### Alternatives:
- `anthropic/claude-3.5-sonnet` - Excellent quality, slightly more expensive
- `google/gemini-pro-vision` - Good quality, competitive pricing
- `openai/gpt-4o` - Highest quality, more expensive

## Setup

### 1. Get OpenRouter API Key
1. Sign up at https://openrouter.ai
2. Get API key from dashboard
3. Add to `.env`:
```bash
OPENROUTER_API_KEY=your-openrouter-api-key
VISION_ENABLED=true
VISION_MODEL=openai/gpt-4o-mini
```

### 2. Enable Vision
```bash
export VISION_ENABLED=true
export OPENROUTER_API_KEY=your-openrouter-api-key
```

## Usage

### Endpoint 1: Classify with Image URL
```bash
curl -X POST https://api.tas.fly.dev/v1/classify \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Check this image",
    "image_url": "https://example.com/spam-image.jpg"
  }'
```

### Endpoint 2: Upload Image
```bash
curl -X POST https://api.tas.fly.dev/v1/classify/image/upload \
  -H "x-api-key: YOUR_KEY" \
  -F "image=@spam-image.jpg" \
  -F "text=Optional text"
```

### Endpoint 3: Image-Only Analysis
```bash
curl -X POST https://api.tas.fly.dev/v1/classify/image \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://example.com/spam-image.jpg"
  }'
```

## Response Format

Same as regular `/classify` but with:
- `has_image_analysis: true` if vision was used
- `layers_used: ["vision", "rules"]` includes "vision"
- `reasons` may include "Vision: detected_text" entries

## How It Works

1. **Image Analysis**: Vision model extracts text from image
2. **Text Detection**: Looks for promotional text, URLs, contacts
3. **Spam Indicators**: Detects commercial offers, job ads, etc.
4. **Combined Score**: Merges vision results with text rules
5. **Caching**: Results cached to avoid repeated API calls

## Cost Estimation

With `gpt-4o-mini`:
- **Per image**: ~$0.0001-0.0005 (very cheap)
- **1000 images**: ~$0.10-0.50
- **10k images/month**: ~$1-5

Much cheaper than dedicated OCR services!

## Quality

**Text Recognition**: Excellent
- Handles printed text, handwritten (if clear), multiple languages
- Detects URLs, phone numbers, emails in images

**Spam Detection**: Good
- Identifies promotional content
- Detects commercial offers
- Finds contact information

## Limitations

- **Image Size**: Max 10MB for uploads
- **Formats**: JPEG, PNG, WebP supported
- **Text Quality**: Works best with clear, readable text
- **Language**: Works with any language (model is multilingual)

## Best Practices

1. **Use for suspicious images**: Only analyze when text rules are uncertain
2. **Cache results**: Vision results are cached automatically
3. **Combine with text**: Provide text if available for better accuracy
4. **Monitor costs**: Track vision API usage in OpenRouter dashboard

## Integration Example

```python
import requests

response = requests.post(
    "https://api.tas.fly.dev/v1/classify",
    headers={"x-api-key": "YOUR_KEY"},
    json={
        "text": "Check this offer",
        "image_url": "https://example.com/promo.jpg"
    }
)

result = response.json()
if result.get("has_image_analysis"):
    print("Image analyzed!")
    print(f"Spam score: {result['score']}")
```

## Troubleshooting

### Vision not working?
1. Check `VISION_ENABLED=true` in `.env`
2. Verify `OPENROUTER_API_KEY` is set
3. Check OpenRouter dashboard for API usage/errors
4. Review logs: `tail -f logs/app.log`

### High costs?
- Use `gpt-4o-mini` (cheapest option)
- Enable caching (default: 24h TTL)
- Only analyze suspicious images
- Monitor usage in OpenRouter dashboard

---
**Ready to use!** Just set `VISION_ENABLED=true` and `OPENROUTER_API_KEY`.
