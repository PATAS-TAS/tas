# LLM Modes

TAS supports three modes for LLM usage: **Managed**, **BYO (Bring Your Own)**, and **Rules-only**.

## Managed Mode (Default)

Uses TAS-managed LLM credentials configured via environment variables.

**Configuration:**
- Set `PATAS_OPENAI_API_KEY` or `OPENAI_API_KEY` environment variable
- Default mode if `llm_mode` is not specified

**Example:**
```bash
curl -X POST https://tas.fly.dev/v1/classify \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Скидки -70% сегодня!"}'
```

**Response:**
```json
{
  "spam": true,
  "score": 0.91,
  "reasons": [...],
  "path": "llm",
  "mode": "managed",
  "request_id": "r_01ab234cdef"
}
```

## BYO Mode (Bring Your Own)

Use your own LLM provider credentials. Useful for:
- Cost control (you pay directly to provider)
- Compliance requirements (data stays with your provider)
- Custom LLM providers

**Headers Required:**
- `X-LLM-Mode: byo`
- `X-LLM-Provider: openai` (currently only OpenAI supported)
- `X-LLM-Key: your-api-key`

**Example:**
```bash
curl -X POST https://tas.fly.dev/v1/classify \
  -H "x-api-key: YOUR_KEY" \
  -H "X-LLM-Mode: byo" \
  -H "X-LLM-Provider: openai" \
  -H "X-LLM-Key: sk-your-openai-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "Скидки -70% сегодня!"}'
```

**Response:**
```json
{
  "spam": true,
  "score": 0.91,
  "reasons": [...],
  "path": "llm",
  "mode": "byo",
  "request_id": "r_01ab234cdef"
}
```

**Security Notes:**
- BYO keys are **never logged** or stored
- Only a hash identifier is stored for session tracking
- Keys are used only for the specific request and discarded

**Error Handling:**
If BYO provider fails, the request automatically falls back to rules-only classification:
```json
{
  "spam": false,
  "score": 0.45,
  "reasons": [...],
  "path": "rules",
  "mode": "rules_only",
  "request_id": "r_01ab234cdef"
}
```

## Rules-Only Mode

Disable LLM entirely. Fastest mode, lowest cost.

**Headers:**
- `X-LLM-Mode: rules_only`

**Example:**
```bash
curl -X POST https://tas.fly.dev/v1/classify \
  -H "x-api-key: YOUR_KEY" \
  -H "X-LLM-Mode: rules_only" \
  -H "Content-Type: application/json" \
  -d '{"text": "Скидки -70% сегодня!"}'
```

**Response:**
```json
{
  "spam": true,
  "score": 0.85,
  "reasons": [...],
  "path": "rules",
  "mode": "rules_only",
  "request_id": "r_01ab234cdef"
}
```

**Performance:**
- P95 latency: ~200ms (vs ~700ms with LLM)
- No LLM costs
- Best for high-volume, low-latency requirements

## SDK Examples

### Python
```python
from tas_sdk import TASClient

client = TASClient(api_key="YOUR_KEY")

# Managed mode (default)
result = client.classify("Скидки -70%!")

# BYO mode
result = client.classify(
    "Скидки -70%!",
    headers={
        "X-LLM-Mode": "byo",
        "X-LLM-Provider": "openai",
        "X-LLM-Key": "sk-your-key"
    }
)

# Rules-only mode
result = client.classify(
    "Скидки -70%!",
    headers={"X-LLM-Mode": "rules_only"}
)
```

### Node.js
```javascript
const { TASClient } = require('tas-sdk');

const client = new TASClient('YOUR_KEY');

// Managed mode (default)
const result = await client.classify('Скидки -70%!');

// BYO mode
const result = await client.classify('Скидки -70%!', 'ru', null, null, {
  'X-LLM-Mode': 'byo',
  'X-LLM-Provider': 'openai',
  'X-LLM-Key': 'sk-your-key'
});

// Rules-only mode
const result = await client.classify('Скидки -70%!', 'ru', null, null, {
  'X-LLM-Mode': 'rules_only'
});
```

## Configuration

Default mode can be set via environment variable:
```bash
export LLM_MODE=managed  # or byo, rules_only
```

Or in `.env` file:
```
LLM_MODE=managed
```

## Cost Comparison

| Mode | LLM Cost | Latency P95 | Use Case |
|------|----------|-------------|----------|
| Managed | TAS pays | ~700ms | Default, balanced |
| BYO | You pay | ~700ms | Cost control, compliance |
| Rules-only | Free | ~200ms | High volume, low latency |

## Best Practices

1. **Start with Managed**: Use managed mode for testing and initial deployment
2. **Switch to BYO**: If you have high volume or specific compliance needs
3. **Use Rules-only**: For high-volume scenarios where sub-200ms latency is critical
4. **Monitor mode usage**: Check `mode` field in responses to track actual mode used
5. **Handle fallbacks**: Always check `mode` in response - BYO may fall back to rules-only on error

## Migration

If you're migrating from managed to BYO:
1. Test with BYO mode on a small percentage of traffic
2. Monitor `mode` field in responses
3. Gradually increase BYO traffic
4. Keep managed as fallback until BYO is stable

---

See also: [API Migration Guide](./MIGRATION.md), [Pricing & Limits](./PRICING_LIMITS.md)

