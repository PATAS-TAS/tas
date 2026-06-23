# TAS

TAS is a FastAPI service for classifying commercial spam with rules-first detection and optional LLM fallback.

**[Run the local API](#quickstart)**

[Hosted demo](https://kiku-jw.github.io/tas/) · [OpenAPI](openapi.yaml) · [LLM modes](docs/LLM_MODES.md)

Use TAS when you need to flag buy/sell offers, job solicitations, service ads, and similar commercial spam in chats, forums, marketplaces, or messaging products. It is not a toxicity, hate-speech, political-content, or general conversation classifier.

## Quickstart

Python 3.10 and Poetry are required.

```bash
poetry install
cp env.example .env
poetry run uvicorn app.main:app --reload
```

Then open:

```text
http://localhost:8000/docs
```

Classify one message:

```bash
curl -X POST http://localhost:8000/v1/classify \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Earn $1000/day working from home! Click https://example.com",
    "lang": "en"
  }'
```

Expected response shape:

```json
{
  "spam": true,
  "score": 0.92,
  "reasons": [],
  "path": "rules",
  "mode": "rules_only",
  "request_id": "r_abc123def456"
}
```

The exact score and reason list depend on the enabled rules and model mode.

## What it includes

- `/v1/classify` REST endpoint for single-message commercial spam classification.
- Rules-first pipeline with optional LLM fallback and cache/budget controls.
- Prometheus metrics endpoints and CLI monitoring helpers.
- Feedback endpoints for false-positive and false-negative review loops.
- Python, Node.js, Go, Java, and PHP example clients under [examples/](examples/).
- Python, Node.js, and Go SDK package directories under [sdks/](sdks/).
- Release and RapidAPI packaging materials under [release/rapidapi-pack/](release/rapidapi-pack/).

## Detection scope

TAS is shaped around commercial spam signals such as:

- buy/sell offers;
- job and work-from-home solicitations;
- service ads;
- real-estate rental or sale messages;
- promotion and discount messages with external calls to action.

It does not try to classify:

- toxicity or hate speech;
- personal conflict;
- political content;
- normal conversation quality.

## LLM modes

TAS supports multiple operating modes:

- `rules_only` for deterministic classification without LLM calls;
- managed LLM fallback;
- bring-your-own LLM provider headers.

See [docs/LLM_MODES.md](docs/LLM_MODES.md) for the mode contract and request examples.

## Evaluation and release evidence

The repository contains evaluation and launch-support artifacts, but the README does not treat them as universal performance guarantees.

- [reports/canary/DRY_RUN.md](reports/canary/DRY_RUN.md) records a canary dry-run status and explicitly marks 24-hour stability as pending.
- [reports/examples_run.md](reports/examples_run.md) records example-client checks from 2025-11-05.
- [NIGHTLY_EVALUATOR.md](NIGHTLY_EVALUATOR.md) describes the recurring evaluation script and expected input file.
- [RAPIDAPI_DOCS.md](RAPIDAPI_DOCS.md) and [RAPIDAPI_CARD.md](RAPIDAPI_CARD.md) are marketplace packaging drafts and should be re-verified before publication.

## Self-hosting notes

Configuration starts from [env.example](env.example). Important values include:

- `OPENAI_API_KEY` for optional LLM fallback;
- `LLM_MODE` for managed, BYO, or rules-only behavior;
- `DAILY_BUDGET_USD` and related budget controls;
- `PII_REDACTION_ENABLED` for log redaction behavior.

Docker and deployment files are included:

```bash
docker build -t tas .
docker run -p 8000:8000 --env-file .env tas
```

## Tests

```bash
poetry run pytest
poetry run ruff check .
poetry run mypy app
```

These commands require the Poetry environment. This README update did not reinstall the full Python dependency stack.

## Documentation

- [API examples page](docs/api-examples.html)
- [Status page](docs/status.html)
- [Feedback system](FEEDBACK_SYSTEM.md)
- [Pricing limits](PRICING_LIMITS.md)
- [Architecture review](ARCHITECTURE_REVIEW.md)
- [RapidAPI launch checklist](RAPIDAPI_LAUNCH_CHECKLIST.md)
- [Privacy policy](LEGAL/PRIVACY_POLICY.md)
- [Terms of service](LEGAL/TERMS_OF_SERVICE.md)

## License

MIT. See [LICENSE](LICENSE).
