# Changelog

## [1.0.3] - 2025-01-15

### Added
- **API Versioning**: `/v1/` prefix for all endpoints
- **Prometheus Metrics**: latency_p95, fpr, recall, llm_hit_rate, llm_cost_usd
- **Alerts System**: Budget and FPR alerts
- **CLI Tool**: `tas stats` for monitoring metrics
- **Python SDK**: Official SDK for Python (`tas-sdk`)
- **Node.js SDK**: Official SDK for Node.js (`tas-sdk`)
- **RapidAPI Documentation**: Complete API documentation for marketplace listing
- **Feedback System**: Production feedback loop for FP/FN
- **Nightly Evaluator**: Automated quality assessment with reports
- **Canary & Shadow Rules**: Safe rule testing without blocking

### Changed
- Updated Pydantic config to use `ConfigDict` (fixes deprecation warning)
- Replaced `@app.on_event` with `lifespan` context manager (FastAPI best practice)
- Updated `regex` parameter to `pattern` in Query (FastAPI deprecation)
- Default `decision_threshold` set to 0.35 (optimized for recall/FPR balance)

### Fixed
- Fixed incomplete logger.warning statement in pipeline.py
- Fixed duplicate logger.warning call
- Updated poetry.lock with new dependencies

### Performance
- Parallel execution of RRS, LUR, and SIG modules
- LLM early exit when rules score > 0.8
- Persistent HTTP connections for LLM and LUR
- Warm-up phase at startup for faster first requests

### Monitoring
- Prometheus metrics endpoint at `/v1/metrics`
- Cost tracking (daily/monthly budgets)
- Alert system for budget and FPR thresholds
- CLI tool for real-time metrics viewing

### Documentation
- RapidAPI documentation (RAPIDAPI_DOCS.md)
- Feedback system documentation (FEEDBACK_SYSTEM.md)
- Nightly evaluator documentation (NIGHTLY_EVALUATOR.md)
- Architecture review (ARCHITECTURE_REVIEW.md)

## [1.0.2] - Previous

- Initial MVP release
- Rules + LLM pipeline
- Basic spam detection

