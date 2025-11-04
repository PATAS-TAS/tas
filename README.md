# TAS - Universal Anti-Spam API

**Multi-layer spam detection service** for messengers, bots, forums, and any text input.

[![Demo](https://img.shields.io/badge/demo-live-green)](https://kiku-jw.github.io/tas/)
[![API](https://img.shields.io/badge/API-Fly.io-blue)](https://tas-api.fly.dev)
[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104+-green.svg)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Cost-effective alternative to pure LLM-based spam detection** - 90%+ of requests are handled by fast rule-based and ML layers, avoiding expensive LLM calls.

## Features

- **Multi-layer detection**: Rules → ML → LLM (only when needed)
- **Cost-effective**: LLM used only when rules + ML can't decide (90%+ requests avoid LLM)
- **Fast**: Rules layer < 10ms, ML layer < 100ms
- **Accurate**: Combines multiple detection methods for better precision
- **Universal**: Works for any text input (messengers, bots, forums, comments)

## Architecture

```
Text Input
  ↓
Fast Rules Check (regex patterns)
  ├─ Confidence ≥ 0.7 → Return immediately (free, instant)
  ↓ Confidence < 0.7
ML Model Check (HuggingFace transformer)
  ├─ Confidence ≥ 0.8 → Return (cheap, fast)
  ↓ Confidence < 0.8
LLM Check (OpenAI GPT-4o-mini, fallback only)
  └─ Final decision (expensive, but accurate)
```

**Cost Analysis:**
- Rules: Free (regex patterns)
- ML: ~$0.0001 per request
- LLM: ~$0.001 per request (only 5-10% of requests)

## Quick Start

### Installation

```bash
cd tas
poetry install
cp env.example .env
# Edit .env with your OpenAI API key (optional, LLM is fallback only)
```

### Run

```bash
poetry run uvicorn app.main:app --reload
```

API will be available at `http://localhost:8000`

### API Usage

```bash
curl -X POST http://localhost:8000/classify \
  -H "Content-Type: application/json" \
  -d '{"text": "Заработок без вложений! Переходи https://...", "lang": "ru"}'
```

### Response

```json
{
  "spam_score": 0.87,
  "confidence": 0.92,
  "labels": ["spam", "scam"],
  "reasons": ["Contains URL", "Job offer or work solicitation"],
  "layers_used": ["rules", "ml"],
  "version": "1.0.0"
}
```

## Testing

Test on `report.csv` (from parent directory):

```bash
poetry run python tests/test_report_csv.py
```

This will:
- Load test data from `report.csv`
- Run classification on samples
- Calculate accuracy, precision, recall, F1 score
- Show layer usage statistics

## API Documentation

### POST /classify

Classify text for spam.

**Request:**
```json
{
  "text": "Your text here",
  "lang": "en"
}
```

**Response:**
```json
{
  "spam_score": 0.87,
  "confidence": 0.92,
  "labels": ["spam", "scam"],
  "reasons": ["Contains URL", "Job offer"],
  "layers_used": ["rules", "ml"],
  "version": "1.0.0"
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

## Configuration

Environment variables (`.env`):

- `OPENAI_API_KEY` - OpenAI API key for LLM fallback (optional)
- `MODEL_NAME` - HuggingFace model name (default: `unitary/multilingual-toxic-xlm-roberta`)
- `RULES_THRESHOLD` - Rules layer threshold (default: 0.7)
- `ML_THRESHOLD` - ML layer threshold (default: 0.8)
- `LLM_FALLBACK` - Enable LLM fallback (default: true)

## Deployment

### Fly.io (Recommended)

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# Deploy
fly launch --name tas-api --region iad
fly secrets set OPENAI_API_KEY=your_key_here
fly deploy
```

API will be available at: `https://tas-api.fly.dev`

### Docker

```bash
docker build -t tas .
docker run -p 8000:8000 --env-file .env tas
```

### GitHub Pages

Demo page is automatically deployed to GitHub Pages: https://kiku-jw.github.io/tas/

### RapidAPI

Ready for RapidAPI marketplace deployment. See `RAPIDAPI_GUIDE.md` for details.

## Project Structure

```
tas/
├── app/
│   ├── __init__.py
│   ├── main.py          # FastAPI application
│   ├── config.py        # Configuration
│   ├── pipeline.py      # Multi-layer detection pipeline
│   ├── regex_patterns.py # Rules layer
│   ├── ml_model.py      # ML layer
│   └── llm_check.py     # LLM layer
├── tests/
│   └── test_report_csv.py
├── docs/
│   └── index.html       # GitHub Pages demo
├── .github/
│   └── workflows/       # CI/CD and Pages
├── README.md
├── pyproject.toml
└── Dockerfile
```

## Performance

Tested on `report.csv` dataset:
- **Rules layer**: Catches 60-70% of spam instantly
- **ML layer**: Adds 20-30% more detection
- **LLM layer**: Used only for 5-10% of edge cases
- **Average latency**: < 50ms (rules + ML), < 1000ms (with LLM)

## Contributing

Contributions welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) file for details.
