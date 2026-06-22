# RapidAPI Launch Checklist

## Pre-Launch (Complete before Sandbox submission)

### ✅ API Implementation
- [x] Dual-format response (new + legacy fields)
- [x] Deprecation headers (Deprecation, Sunset, Link)
- [x] X-TAS-Request-ID header
- [x] Enhanced reasons[] with code, text, weight
- [x] /v1/batch endpoint (100 items, 256KB cap)
- [x] /v1/healthz alias
- [x] Health endpoint with build, ruleset_version, llm_status
- [x] Graceful degradation (HTTP 200 on errors)
- [x] Circuit breaker for LLM (3 failures → 120s down)
- [x] Retry logic with exponential backoff

### ✅ Documentation
- [x] OpenAPI 3.0 specification (openapi.yaml)
- [x] Postman collection (postman_collection.json)
- [x] Migration guide (MIGRATION.md + docs/index.html#migration)
- [x] Pricing & Limits (PRICING_LIMITS.md)
- [x] SDK READMEs (Python, Node.js, Go)

### ✅ SDKs
- [x] Python SDK with batch support
- [x] Node.js SDK with batch support
- [x] Go SDK with batch support
- [x] Examples in each SDK

### ✅ Testing
- [x] Sandbox smoke tests (200, 400, 401, 429, 5xx scenarios)
- [x] Unit tests for core functionality
- [x] Integration tests for pipeline

## Sandbox Validation

### Test Scenarios
Run `tests/test_sandbox_scenarios.py` and verify:
- [ ] 200 OK - single classification
- [ ] 200 OK - batch classification
- [ ] 400 Bad Request - empty text
- [ ] 400 Bad Request - text too long
- [ ] 400 Bad Request - batch too many items
- [ ] 400 Bad Request - batch item text too long
- [ ] 429 Rate Limit Exceeded
- [ ] Health endpoints (health, healthz)
- [ ] Metrics endpoint (Prometheus format)
- [ ] Graceful degradation

## RapidAPI Card Content

### Title & Description
- **Title**: TAS — Fast & Safe Commercial Anti-Spam API
- **Short Description**: Fast & Safe commercial anti-spam. Rules-first, LLM-assist on demand. FPR < 5%, Precision ~95%, P95 200-700ms.
- **Full Description**: See `RAPIDAPI_DOCS.md` (to be created/updated)

### Pricing
- Free: 1k req/month (promo: 3k for 60 days), rules-only, 2 rps
- Starter: $9/month, 50k req, LLM ≤ 10%, overage $2/10k
- Pro: $49/month, 500k req, LLM ≤ 15%, overage $1.5/10k
- Enterprise: Custom

### Endpoints
- `POST /v1/classify` - Single classification
- `POST /v1/batch` - Batch classification (up to 100 items)
- `GET /v1/health` / `/v1/healthz` - Health check
- `GET /v1/metrics` - Prometheus metrics

### Examples
See `openapi.yaml` for request/response examples.

### Screenshots & Media
- [ ] Demo page screenshot (showing latency graphs)
- [ ] API response example screenshot
- [ ] GIF showing latency over time (P95 trends)
- [ ] Architecture diagram (optional)

## Post-Launch

### Monitoring
- [ ] Set up uptime monitoring (Pingdom/UptimeRobot)
- [ ] Configure SLO alerts (FPR > 5%, P95 > 700ms, error rate > 0.5%)
- [ ] Dashboard for key metrics

### Documentation URLs
- **Public Docs**: `https://kiku-jw.github.io/tas/` (after Pages setup)
- **Migration Guide**: `https://kiku-jw.github.io/tas/#migration`
- **RapidAPI Docs**: `https://rapidapi.com/[username]/api/[api-name]` (after listing)

## Notes

- **License**: BUSL-1.1 for service/rules, Apache-2.0 for SDKs/docs
- **Change Date**: 2028-01-01
- **API Stability**: v1 stable for 6 months minimum
- **Deprecation Window**: 6 months (180 days)

