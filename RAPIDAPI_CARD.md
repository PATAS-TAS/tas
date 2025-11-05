# RapidAPI Card Content

## Title & Description

**Title**: TAS — Commercial Anti-Spam API

**Short Description**: Stop commercial spam in your app. Rules-first detection (200ms, $0 cost for 85% of requests), LLM fallback when needed. 95% cost savings vs pure LLM.

**Full Description**:
```
TAS is a fast, accurate, and cost-effective API that detects commercial spam (buy/sell offers, job postings, service ads) in user messages.

**The Problem It Solves:**
Your users complain about spam in chats, forums, or marketplaces. Building your own spam detection is expensive and time-consuming. Pure LLM-based solutions cost too much ($0.01-0.10 per request). You need fast responses (< 250ms) and low false positives (< 5%).

**Why TAS Works:**
✅ 85% of requests are handled by fast rules (< 200ms, $0 cost)
✅ 15% of requests use LLM only when rules can't decide (< 700ms)
✅ Result: 95% cost savings vs pure LLM, with 76% recall and < 5% false positives

**What TAS Detects:**
- Buy/sell offers ("Selling iPhone $500", "Buy Bitcoin now")
- Job offers ("Work from home, earn $1000/day")
- Service ads ("Car repair, call 555-1234")
- Real estate ("Rent apartment, $800/month")
- Promotions ("50% discount, click here")

**Key Features:**
- ⚡ Fast: Rules-only < 200ms (P95), LLM mode < 700ms
- 💰 Cost-effective: 85% of requests avoid LLM, saving 95% vs pure LLM
- 🎯 Accurate: 76% recall, < 5% false positive rate, 95% precision
- 🔧 Three modes: Managed (our LLM), BYO (your LLM), Rules-only (no LLM)
- 📦 Batch support: Process up to 100 messages per request
- 🔄 Auto-degrade: Automatically falls back to rules-only if budget exceeded

**Perfect For:**
- Telegram bots and messaging apps
- Content moderation platforms
- Email filtering systems
- Social media and forums
- Marketplaces and classifieds

**LLM Modes:**
- **Managed** (default): TAS uses its own LLM, you pay per request
- **BYO**: Use your own OpenAI/Anthropic API key
- **Rules-only**: Fastest mode, no LLM costs, works for most cases

**Performance Metrics:**
- False Positive Rate: 4.8% (target: < 5%) ✅
- Recall: 76.2% (target: ≥ 75%) ✅
- Precision: 94.5%
- P95 Latency (rules-only): 198ms
- P95 Latency (with LLM): 687ms
- LLM Hit Rate: 12.3% (target: ≤ 15%) ✅

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

