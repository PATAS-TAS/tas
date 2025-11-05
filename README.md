# TAS - Transmodal Anti-Spam API

**Transmodal commercial spam detection service** for messengers, forums, and marketplaces. Processes text, images, and other formats with unified scoring across detection layers.

> **Focus**: Commercial spam (buy/sell, job offers, services) - not toxicity or hate speech.

[![Demo](https://img.shields.io/badge/demo-live-green)](https://kiku-jw.github.io/tas/)
[![API](https://img.shields.io/badge/API-Fly.io-blue)](https://tas.fly.dev)
[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104+-green.svg)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Cost-effective alternative to pure LLM-based spam detection** - 80%+ of requests avoid expensive LLM calls.

## Features

- **Multi-layer detection**: Rules → LLM pipeline for accurate spam detection
- **Advanced modules**: RRS (Reputation), LUR (URL Risk), SIG (Signatures), ROL (Rule Orchestrator), QZN (Quarantine)
- **Cost-effective**: LLM used only when rules can't decide (80%+ requests avoid LLM)
- **Fast**: Rules layer < 10ms, LLM fallback < 1000ms, P95 < 100ms
- **Simple API**: One endpoint, simple response
- **Commercial Focus**: Specialized for buy/sell, job offers, services
- **PATAS Integration**: Import rules from PATAS batch analysis system

## What TAS Detects

✅ **Commercial spam:**
- Buy/sell offers
- Job offers and work solicitations
- Service offers (repair, tutoring, etc.)
- Real estate (rent, sale)
- Car sales
- Promotions and discounts

❌ **TAS does NOT detect:**
- Toxicity or hate speech
- Insults or offensive language
- Political content
- Personal conflicts

## Quick Start

### Installation

```bash
cd tas
poetry install
cp env.example .env
```

### Run

```bash
poetry run uvicorn app.main:app --reload
```

API will be available at `http://localhost:8000`

### API Usage

**Using cURL:**
```bash
curl -X POST http://localhost:8000/v1/classify \
  -H "Content-Type: application/json" \
  -d '{"text": "Earn money from home! Click here https://...", "lang": "en"}'
```

**Using Python SDK:**
```python
from tas_sdk import TASClient

client = TASClient(api_key="your-api-key")
result = client.classify("Spam message here", lang="en")
print(f"Is spam: {result['is_spam']}")
```

**Using Node.js SDK:**
```javascript
const { TASClient } = require('tas-sdk');

const client = new TASClient('your-api-key');
client.classify('Spam message here', 'en')
    .then(result => console.log(result));
```

### Response

```json
{
  "is_spam": true,
  "confidence": 0.92,
  "reason": "Contains URL and Job offer or work solicitation"
}
```

## Feedback System

TAS includes a production feedback loop for continuous improvement:

- **POST `/feedback`** - Submit FP/FN examples from production
- **GET `/feedback/report`** - Get detailed statistics per rule
- **GET `/feedback/entries`** - Browse feedback entries

Feedback is stored in SQLite database and used to generate reports showing which rules have high false positive/negative rates.

See [FEEDBACK_SYSTEM.md](FEEDBACK_SYSTEM.md) for detailed documentation.

## Configuration

Environment variables (`.env`):

- `OPENAI_API_KEY` - OpenAI API key for LLM fallback (optional)
- `PATAS_OPENAI_API_KEY` - PATAS-specific OpenAI API key (takes precedence)
- `PATAS_URL` - PATAS API URL for rule import (default: `http://localhost:8000`)
- `PATAS_API_KEY` - PATAS API key (optional)
- `ENABLE_RRS` - Enable Reputation & Rate Sentinel (default: `true`)
- `ENABLE_LUR` - Enable Link & URL Risk (default: `true`)
- `ENABLE_SIG` - Enable Signatures (default: `true`)
- `ENABLE_ROL` - Enable Rule Orchestrator (default: `false`)
- `ENABLE_QZN` - Enable Quarantine (default: `false`)

## Deployment

### Fly.io

```bash
flyctl deploy
```

API will be available at: `https://tas.fly.dev`

### Docker

```bash
docker build -t tas .
docker run -p 8000:8000 --env-file .env tas
```

### Demo

Live demo: https://kiku-jw.github.io/tas/

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
