# TAS - Development Roadmap

## Current Status (v1.0.0)

✅ **Core Features:**
- Multi-layer detection (Rules → ML → LLM)
- Commercial spam focus (buy/sell, jobs, services)
- FastAPI REST API
- GitHub Pages demo
- Fly.io deployment ready

## Phase 1: Pattern Optimization (Current Focus)

### 1.1 Improve Commercial Patterns
- [ ] Add more specific buy/sell patterns
  - Price mentions (от, руб, $)
  - Condition indicators (новый, б/у, состояние)
  - Contact methods (звоните, пишите, WhatsApp)
- [ ] Expand job offer patterns
  - Specific job types (грузчик, курьер, менеджер)
  - Salary mentions (оклад, зарплата, от X рублей)
  - Work schedule (смены, график, ежедневная оплата)
- [ ] Add service category patterns
  - Repair services (ремонт, починка)
  - Tutoring (репетитор, обучение)
  - Cleaning (уборка, клининг)

### 1.2 Pattern Testing
- [ ] Test all patterns on report.csv
- [ ] Measure false positive/negative rates
- [ ] Optimize pattern weights
- [ ] Remove low-performing patterns

### 1.3 Context Awareness
- [ ] Detect price ranges (reasonable vs suspicious)
- [ ] Check for legitimate marketplace context
- [ ] Improve phone/email detection in commercial context

## Phase 2: ML Model Enhancement

### 2.1 Model Selection
- [ ] Test multiple HuggingFace models
- [ ] Compare accuracy for commercial spam
- [ ] Consider fine-tuning on commercial spam dataset

### 2.2 Model Optimization
- [ ] Optimize inference speed
- [ ] Reduce model size if possible
- [ ] Add caching for repeated texts

### 2.3 Custom Training
- [ ] Prepare training dataset from report.csv
- [ ] Fine-tune model on commercial spam
- [ ] Validate improvements

## Phase 3: API Enhancements

### 3.1 Additional Endpoints
- [ ] GET /patterns - List all detection patterns
- [ ] POST /patterns/test - Test pattern on text
- [ ] GET /stats/detailed - Detailed statistics
- [ ] POST /batch - Batch classification

### 3.2 Rate Limiting
- [ ] Implement per-API-key rate limiting
- [ ] Add rate limit headers
- [ ] Support different tiers

### 3.3 Caching
- [ ] Add Redis caching layer
- [ ] Cache frequent requests
- [ ] TTL-based cache invalidation

## Phase 4: Advanced Features

### 4.1 Category Detection
- [ ] Detect spam category (buy/sell, job, service)
- [ ] Return category in response
- [ ] Support category filtering

### 4.2 Confidence Scoring
- [ ] Improve confidence calculation
- [ ] Add per-layer confidence
- [ ] Explainable AI features

### 4.3 Language Support
- [ ] Improve Russian language detection
- [ ] Add more language patterns
- [ ] Support mixed-language texts

## Phase 5: RapidAPI Integration

### 5.1 API Documentation
- [ ] Complete OpenAPI schema
- [ ] Add examples for all endpoints
- [ ] Create integration guides

### 5.2 Pricing Strategy
- [ ] Define pricing tiers
- [ ] Implement usage tracking
- [ ] Add billing integration

### 5.3 Marketing
- [ ] Create landing page
- [ ] Write case studies
- [ ] Prepare demo videos

## Performance Goals

- **Accuracy**: > 95% for commercial spam
- **False Positives**: < 3%
- **Latency**: < 50ms (rules + ML), < 500ms (with LLM)
- **Throughput**: 100+ requests/second
- **Cost**: < $0.0001 per request average

## Success Metrics

- **API Usage**: 1000+ requests/day
- **Customer Satisfaction**: > 4.5/5
- **Uptime**: > 99.9%
- **Response Time**: < 100ms (p95)

