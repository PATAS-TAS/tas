# RapidAPI Card Content

## Title & Description

**Title**: TAS — Fast & Safe Commercial Anti-Spam API

**Short Description**: Fast & Safe commercial anti-spam. Rules-first, LLM-assist on demand. FPR < 5%, Precision ~95%, P95 200-700ms.

**Full Description**:
```
TAS is a fast and safe commercial anti-spam API designed for developers who need reliable spam detection without the complexity of building and maintaining their own models.

**Key Features:**
- Low False Positive Rate: < 5% (actual: 4.8%)
- High Recall: ≥ 75% (actual: 76.2%)
- Fast Performance: P95 198ms (rules-only), 687ms (with LLM)
- Three LLM Modes: Managed, BYO (Bring Your Own), Rules-only
- Batch Classification: Up to 100 items per request
- Comprehensive SDKs: Python, Node.js, Go

**How It Works:**
1. Rules-first detection (fast, low-cost)
2. Signal modules (RRS, LUR, SIG) for enhanced accuracy
3. LLM fallback only when needed (≤ 15% of requests)

**Use Cases:**
- Telegram bots and messaging apps
- Content moderation platforms
- Email filtering systems
- Social media platforms

**Modes:**
- **Managed**: Uses TAS-managed LLM (default)
- **BYO**: Use your own LLM provider credentials
- **Rules-only**: Fastest mode, no LLM costs

Try it now with our free tier (1k requests/month, rules-only).
```

## KPI Metrics

**Performance Metrics:**
- False Positive Rate (FPR): **4.8%** (target: < 5%)
- Recall: **76.2%** (target: ≥ 75%)
- Precision: **94.5%**
- F1 Score: **83.1%**
- P95 Latency (rules-only): **198ms**
- P95 Latency (with LLM): **687ms**
- LLM Hit Rate: **12.3%** (target: ≤ 15%)

## Pricing

### Free Tier
- **1,000 requests/month**
- **2 requests/second**
- **Rules-only mode** (no LLM)
- Perfect for testing and small projects

### Starter - $9/month
- **50,000 requests/month**
- **LLM fallback up to 5%**
- **Overage**: +20% to CPM
- **Rate limit**: 10 rps
- Email support

### Growth - $49/month
- **500,000 requests/month**
- **LLM fallback up to 10%**
- **Overage**: +20% to CPM
- **Rate limit**: 50 rps
- Priority support

### Pro - $199/month
- **3,000,000 requests/month**
- **LLM fallback up to 15%**
- **Overage**: +20% to CPM
- **Rate limit**: 200 rps
- SLA: 99.5% uptime
- Priority support

### Enterprise
- Custom volume and pricing
- Dedicated instances
- SLA: 99.9% uptime
- Custom allow/deny lists
- Multi-tenant support

## Screenshots & Media

1. **Demo Page Screenshot**: Shows interactive demo with spam detection
2. **API Response Example**: JSON response with spam=true, reasons, path, mode
3. **Latency Graph GIF**: P95 latency trends over time (rules-only vs with LLM)
4. **Postman Collection**: "Run in Postman" button

## Links

- **OpenAPI Spec**: `https://github.com/kiku-jw/tas/blob/main/tas/openapi.yaml`
- **Postman Collection**: `https://github.com/kiku-jw/tas/blob/main/tas/postman_collection.json`
- **Python SDK**: `https://github.com/kiku-jw/tas/tree/main/tas/sdks/python`
- **Node.js SDK**: `https://github.com/kiku-jw/tas/tree/main/tas/sdks/nodejs`
- **Go SDK**: `https://github.com/kiku-jw/tas/tree/main/tas/sdks/go`
- **Migration Guide**: `https://kiku-jw.github.io/tas/#migration`
- **Documentation**: `https://kiku-jw.github.io/tas/`

## Endpoints

- `POST /v1/classify` - Single classification
- `POST /v1/batch` - Batch classification (up to 100 items)
- `GET /v1/health` / `/v1/healthz` - Health check
- `GET /v1/metrics` - Prometheus metrics

## Example Request/Response

**Request:**
```bash
curl -X POST https://tas.fly.dev/v1/classify \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Скидки -70% сегодня, пишите в тг @sale_best!", "lang": "ru"}'
```

**Response:**
```json
{
  "spam": true,
  "score": 0.91,
  "reasons": [
    {"code": "commercial_trade_offer", "text": "Commercial trade offer", "weight": 0.4},
    {"code": "sale_or_promotion", "text": "Sale or promotion", "weight": 0.35}
  ],
  "path": "rules",
  "mode": "managed",
  "request_id": "r_01ab234cdef",
  "is_spam": true,
  "confidence": 0.91,
  "reason": "Commercial trade offer and 1 more"
}
```

## Tags

- `spam-detection`
- `content-moderation`
- `anti-spam`
- `nlp`
- `api`
- `machine-learning`
- `telegram`
- `messaging`

