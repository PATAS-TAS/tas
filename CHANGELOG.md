# Changelog

All notable changes to TAS will be documented in this file.

## [1.0.1] - 2025-01-XX

### Added
- **LLM cost optimization** - ML skips LLM when confident content is safe (ml_safe_threshold)
- **Spam category detection** - Automatically categorizes spam (job_offer, buy_sell, car_sale, real_estate, service, scam)
- **LRU cache with TTL** - Cache classification results for faster responses
- **Category field in response** - Returns detected spam category
- **Rate limiting** - Per-IP rate limiting (100 requests per minute)
- **Rate limit headers** - X-RateLimit-Remaining and Retry-After headers
- **Expanded patterns** - Additional keywords for job offers and commercial offers
- **Batch classification endpoint** (`POST /batch`) - Classify multiple texts at once
- **Patterns listing endpoint** (`GET /patterns`) - List all detection patterns
- **Service category patterns** - Added patterns for repair, tutoring, and cleaning services
- **Patterns-only test** (`tests/test_patterns_only.py`) - Test rules layer without ML/LLM dependencies
- **Protobuf dependency** - Added for ML model support
- **Multiple commercial indicators boost** - Higher score when multiple commercial patterns detected

### Improved
- **Error handling** - Better error messages and validation
- **API documentation** - Added endpoints list to root endpoint
- **Demo error handling** - Improved error messages and API endpoint fallback

### Fixed
- **DOM element access** - Fixed "Element not found" error in demo
- **ML model dependencies** - Added protobuf for proper model loading
- **ML model tokenizer** - Improved tokenizer loading with fallback for SentencePiece models
- **Demo event listeners** - Fixed event listener setup for better DOM handling

### Improved
- **Pattern coverage** - Expanded job offer and commercial trade patterns
- **Error handling** - Better error messages and validation
- **API documentation** - Added endpoints list to root endpoint

## [1.0.0] - 2025-01-XX

### Initial Release
- Multi-layer detection (Rules → ML → LLM)
- Commercial spam focus
- FastAPI REST API
- GitHub Pages demo
- Fly.io deployment ready

