# TAS — Commercial Anti-Spam API

**Stop commercial spam in your app without expensive LLM calls**

TAS is a fast, accurate, and cost-effective API that detects commercial spam (buy/sell offers, job postings, service ads) in user messages. It uses smart rules to catch 85% of spam instantly, only calling expensive LLM when needed.

[![Demo](https://img.shields.io/badge/demo-live-green)](https://kiku-jw.github.io/tas/)
[![API](https://img.shields.io/badge/API-Fly.io-blue)](https://tas.fly.dev)
[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104+-green.svg)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why TAS?

**The Problem:**
- Your users complain about spam in chats, forums, or marketplaces
- Building your own spam detection is expensive and time-consuming
- Pure LLM-based solutions cost too much ($0.01-0.10 per request)
- You need fast responses (< 250ms) and low false positives (< 5%)

**The Solution:**
TAS uses a **rules-first, LLM-assist** approach:
- ✅ **85% of requests** are handled by fast rules (< 200ms, $0 cost)
- ✅ **15% of requests** use LLM only when rules can't decide (< 700ms)
- ✅ **Result**: 95% cost savings vs pure LLM, with 76% recall and < 5% false positives

**Perfect for:**
- Telegram bots and messaging apps
- Content moderation platforms  
- Email filtering systems
- Social media and forums
- Marketplaces and classifieds

## What TAS Detects

✅ **Commercial spam:**
- Buy/sell offers ("Selling iPhone $500", "Buy Bitcoin now")
- Job offers ("Work from home, earn $1000/day")
- Service ads ("Car repair, call 555-1234")
- Real estate ("Rent apartment, $800/month")
- Promotions ("50% discount, click here")

❌ **TAS does NOT detect:**
- Toxicity or hate speech (use other tools)
- Personal conflicts or insults
- Political content
- General conversation

## Key Features

- **⚡ Fast**: Rules-only mode < 200ms (P95), LLM mode < 700ms
- **💰 Cost-effective**: 85% of requests avoid LLM, saving 95% vs pure LLM solutions
- **🎯 Accurate**: 76% recall, < 5% false positive rate, 95% precision
- **🔧 Three modes**: Managed (our LLM), BYO (your LLM), Rules-only (no LLM)
- **📦 Batch support**: Process up to 100 messages per request
- **🔄 Auto-degrade**: Automatically falls back to rules-only if budget exceeded
- **📊 Production-ready**: Metrics, health checks, SDKs for Python/Node/Go

## Quick Start

### Try it Free

**Live Demo**: https://kiku-jw.github.io/tas/

**API Endpoint**: https://tas.fly.dev/v1/classify

**Free Tier**: 1,000 requests/month (rules-only mode)

### API Usage

**cURL Example:**
```bash
curl -X POST https://tas.fly.dev/v1/classify \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "text": "Earn $1000/day working from home! Click https://scam.com",
    "lang": "en"
  }'
```

**Python SDK:**
```python
from tas_sdk import TASClient

client = TASClient(api_key="your-api-key")
result = client.classify(
    "Selling iPhone 13 Pro Max, $500, call 555-1234",
    lang="en"
)

print(f"Spam: {result['spam']}")           # True
print(f"Score: {result['score']}")         # 0.92
print(f"Reasons: {result['reasons']}")     # [{"code": "url", ...}]
```

**Node.js SDK:**
```javascript
const { TASClient } = require('tas-sdk');

const client = new TASClient('your-api-key');
const result = await client.classify(
    'Work from home! Earn $1000/day!',
    'en'
);

console.log(result.spam);    // true
console.log(result.score);   // 0.87
```

**Response Format:**
```json
{
  "spam": true,
  "score": 0.92,
  "reasons": [
    {
      "code": "url",
      "text": "Contains suspicious URL",
      "weight": 0.6
    },
    {
      "code": "job_offer",
      "text": "Job offer or work solicitation",
      "weight": 0.4
    }
  ],
  "path": "rules",
  "mode": "rules_only",
  "request_id": "req_abc123"
}
```

### LLM Modes

Choose how TAS uses LLM:

1. **Managed** (default): TAS uses its own LLM, you pay per request
2. **BYO**: Use your own OpenAI/Anthropic API key (set `X-LLM-Provider` and `X-LLM-Key` headers)
3. **Rules-only**: Fastest, no LLM costs, works for most cases

```python
# Rules-only mode (fastest, no LLM cost)
result = client.classify(text, lang="en", llm_mode="rules_only")

# BYO mode (use your own LLM key)
result = client.classify(
    text, 
    lang="en",
    llm_mode="byo",
    byo_provider="openai",
    byo_api_key="your-openai-key"
)
```

## Pricing & Plans

- **Free**: 1,000 requests/month, rules-only mode
- **Starter** ($9/mo): 50,000 requests, LLM ≤ 5% of requests
- **Growth** ($49/mo): 500,000 requests, LLM ≤ 10% of requests  
- **Pro** ($199/mo): 3,000,000 requests, LLM ≤ 15% of requests

Overage: +20% to CPM for requests beyond plan limits.

**Available on**: [RapidAPI](https://rapidapi.com) (coming soon)

## Performance Metrics

- **False Positive Rate**: 4.8% (target: < 5%) ✅
- **Recall**: 76.2% (target: ≥ 75%) ✅
- **Precision**: 94.5%
- **F1 Score**: 83.1%
- **P95 Latency** (rules-only): 198ms
- **P95 Latency** (with LLM): 687ms
- **LLM Hit Rate**: 12.3% (target: ≤ 15%) ✅

## Self-Hosting

### Installation

```bash
cd tas
poetry install
cp env.example .env
```

### Run Locally

```bash
poetry run uvicorn app.main:app --reload
```

API will be available at `http://localhost:8000`

### Docker

```bash
docker build -t tas .
docker run -p 8000:8000 --env-file .env tas
```

### Deployment (Fly.io)

```bash
flyctl deploy
```

API will be available at: `https://tas.fly.dev`

## Feedback System

TAS includes a production feedback loop for continuous improvement:

- **POST `/v1/feedback`** - Submit false positive/negative examples
- **GET `/v1/feedback/report`** - Get detailed statistics per rule
- **GET `/v1/feedback/entries`** - Browse feedback entries

Feedback is stored locally and used to generate reports showing which rules have high false positive/negative rates.

See [FEEDBACK_SYSTEM.md](FEEDBACK_SYSTEM.md) for detailed documentation.

## Configuration

Environment variables (`.env`):

- `OPENAI_API_KEY` - OpenAI API key for LLM fallback (optional)
- `LLM_MODE` - Default mode: `managed`, `byo`, or `rules_only`
- `ENABLE_RRS` - Enable Reputation & Rate Sentinel (default: `true`)
- `ENABLE_LUR` - Enable Link & URL Risk (default: `true`)
- `ENABLE_SIG` - Enable Signatures (default: `true`)
- `DAILY_BUDGET_USD` - Daily LLM cost budget (default: $25)
- `DATA_RETENTION_DAYS` - Log retention (default: 7 days)
- `PII_REDACTION_ENABLED` - Redact PII from logs (default: `true`)

## Nightly Evaluation

Automated quality assessment runs nightly to track performance metrics and detect degradation.

### Running Manually

```bash
poetry run python nightly_evaluator.py \
    --sample 1000 \
    --threshold 0.35 \
    --file ../report.csv
```

### Automated Cron Setup

```bash
# Edit crontab
crontab -e

# Add nightly run at 2 AM
0 2 * * * /path/to/tas/scripts/run_nightly_evaluator.sh
```

### Reports

Reports are saved to `reports/` directory:
- `metrics_*.json` - Detailed metrics in JSON format
- `metrics_latest.json` - Latest metrics (symlink)
- `report_*.html` - HTML report for engineers
- `report_latest.html` - Latest report (symlink)
- `trends_*.png` - Trend plots (if matplotlib available)

### Metrics Tracked

- **Precision/Recall/F1** - Detection accuracy
- **FPR/FNR** - False positive/negative rates
- **Latency** - P50, P95, P99 percentiles
- **Trends** - Historical comparison to detect degradation

## SDKs

Official SDKs are available for easy integration:

- **Python SDK:** `sdks/python/` - Install with `pip install tas-sdk`
- **Node.js SDK:** `sdks/nodejs/` - Install with `npm install tas-sdk`

See [RAPIDAPI_DOCS.md](RAPIDAPI_DOCS.md) for complete API documentation and RapidAPI listing details.

## API Versioning

Current API version: **v1**

All endpoints are prefixed with `/v1/`:
- `/v1/classify` - Classify text
- `/v1/health` - Health check
- `/v1/version` - Version info

Legacy endpoints without prefix are maintained for backward compatibility but deprecated.

## License

MIT License - see [LICENSE](LICENSE) file for details.
