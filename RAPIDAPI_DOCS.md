# RapidAPI Listing Documentation

Complete documentation for listing TAS API on RapidAPI marketplace.

## API Overview

**Name:** TAS - Transmodal Anti-Spam API  
**Category:** Content Moderation  
**Description:** Multi-layer commercial spam detection API for messengers, forums, and marketplaces. Detects buy/sell offers, job solicitations, promotions, phishing, and commercial spam using rules-based detection with LLM fallback.

**Key Features:**
- Fast spam detection (< 300ms P95)
- Multi-language support (EN, RU, AR, FR, ES, ZH)
- Cost-effective (80%+ requests avoid expensive LLM calls)
- Production-ready with low false positive rate (<5%)
- Simple REST API with JSON responses

## API Endpoints

### POST /v1/classify

Classify text as spam or not spam.

**Request:**

```json
{
  "text": "Earn money from home! Click here https://spam.com",
  "lang": "en",
  "sender_id": "user123",
  "message_id": "msg456"
}
```

**Parameters:**
- `text` (required, string, 1-8192 chars): Text message to classify
- `lang` (optional, string, default: "en"): Language code (en, ru, ar, fr, es, zh)
- `sender_id` (optional, string): Sender identifier for reputation tracking
- `message_id` (optional, string): Message identifier for tracking

**Response:**

```json
{
  "is_spam": true,
  "confidence": 0.92,
  "reason": "Contains URL and Job offer or work solicitation"
}
```

**Response Fields:**
- `is_spam` (boolean): True if classified as spam
- `confidence` (float, 0.0-1.0): Confidence score
- `reason` (string): Main reason for classification

**Error Responses:**

- `400 Bad Request`: Invalid input (text too long, missing required field)
- `429 Too Many Requests`: Rate limit exceeded (100 requests/minute)
- `500 Internal Server Error`: Server error

**Example (cURL):**

```bash
curl -X POST "https://tas.fly.dev/v1/classify" \
  -H "Content-Type: application/json" \
  -H "X-RapidAPI-Key: YOUR_API_KEY" \
  -d '{
    "text": "Продам iPhone 12, цена 25000 руб",
    "lang": "ru"
  }'
```

### GET /v1/health

Check API health status and get metrics.

**Response:**

```json
{
  "status": "ok",
  "version": "1.0.3",
  "ml_model": "disabled",
  "llm_enabled": true,
  "cache_size": 1234,
  "llm_cache": {
    "total_requests": 1000,
    "cache_hits": 850,
    "hit_rate": 0.85,
    "tokens_saved": 42500
  },
  "rule_orchestrator": {}
}
```

**Example (cURL):**

```bash
curl -X GET "https://tas.fly.dev/v1/health" \
  -H "X-RapidAPI-Key: YOUR_API_KEY"
```

### GET /v1/version

Get API version information.

**Response:**

```json
{
  "version": "1.0.3",
  "api_version": "v1",
  "name": "TAS - Transmodal Anti-Spam API"
}
```

## Request Headers

When using RapidAPI, include these headers:

- `X-RapidAPI-Key`: Your RapidAPI subscription key
- `X-RapidAPI-Host`: `tas.fly.dev`
- `Content-Type`: `application/json`

## Rate Limits

- **Free Tier:** 100 requests/minute
- **Basic Tier:** 500 requests/minute
- **Pro Tier:** 2000 requests/minute
- **Ultra Tier:** 10000 requests/minute

Rate limit headers:
- `X-RateLimit-Remaining`: Remaining requests in current window
- `Retry-After`: Seconds to wait before retry (if rate limited)

## Pricing Tiers (Recommended)

### Free Tier
- **Price:** Free
- **Rate Limit:** 100 requests/minute
- **Use Case:** Testing, development, low-volume applications

### Basic Tier
- **Price:** $9.99/month
- **Rate Limit:** 500 requests/minute
- **Use Case:** Small applications, personal projects

### Pro Tier
- **Price:** $49.99/month
- **Rate Limit:** 2000 requests/minute
- **Use Case:** Medium-scale applications, startups

### Ultra Tier
- **Price:** $199.99/month
- **Rate Limit:** 10000 requests/minute
- **Use Case:** Enterprise applications, high-volume services

## Code Examples

### Python

```python
import requests

url = "https://tas.fly.dev/v1/classify"
headers = {
    "X-RapidAPI-Key": "YOUR_API_KEY",
    "X-RapidAPI-Host": "tas.fly.dev",
    "Content-Type": "application/json"
}
data = {
    "text": "Earn money from home! Click here https://spam.com",
    "lang": "en"
}

response = requests.post(url, json=data, headers=headers)
result = response.json()
print(f"Is spam: {result['is_spam']}")
```

**Using SDK:**

```python
from tas_sdk import TASClient

client = TASClient(api_key="YOUR_API_KEY")
result = client.classify("Spam message here", lang="en")
print(result)
```

### Node.js

```javascript
const axios = require('axios');

const url = 'https://tas.fly.dev/v1/classify';
const headers = {
    'X-RapidAPI-Key': 'YOUR_API_KEY',
    'X-RapidAPI-Host': 'tas.fly.dev',
    'Content-Type': 'application/json'
};
const data = {
    text: 'Earn money from home! Click here https://spam.com',
    lang: 'en'
};

axios.post(url, data, { headers })
    .then(response => {
        console.log(`Is spam: ${response.data.is_spam}`);
    })
    .catch(error => console.error(error));
```

**Using SDK:**

```javascript
const { TASClient } = require('tas-sdk');

const client = new TASClient('YOUR_API_KEY');
client.classify('Spam message here', 'en')
    .then(result => console.log(result))
    .catch(error => console.error(error));
```

### cURL

```bash
curl -X POST "https://tas.fly.dev/v1/classify" \
  -H "Content-Type: application/json" \
  -H "X-RapidAPI-Key: YOUR_API_KEY" \
  -H "X-RapidAPI-Host: tas.fly.dev" \
  -d '{
    "text": "Earn money from home!",
    "lang": "en"
  }'
```

## Use Cases

1. **Telegram Bots:** Filter spam messages in group chats
2. **Messaging Apps:** Pre-moderate user messages
3. **Forums:** Auto-flag commercial spam posts
4. **Marketplaces:** Detect fraudulent listings
5. **Email Services:** Secondary spam filter
6. **Social Media:** Content moderation for posts/comments

## What TAS Detects

✅ **Commercial Spam:**
- Buy/sell offers
- Job offers and work solicitations
- Service offers (repair, tutoring, etc.)
- Real estate (rent, sale)
- Car sales
- Promotions and discounts
- Crypto/Web3 scams
- Referral/affiliate schemes
- NSFW adult content spam
- URL-only spam
- Multilingual spam (AR/FR/ES/ZH/RU)

❌ **TAS does NOT detect:**
- Toxicity or hate speech
- Insults or offensive language
- Political content
- Personal conflicts

## Performance Metrics

- **P95 Latency:** < 300ms (rules-only), < 700ms (with LLM)
- **Accuracy:** 83.8%
- **Precision:** 93.33%
- **Recall:** 72.80%
- **F1 Score:** 81.80%
- **False Positive Rate:** 5.20%

## Support

- **Documentation:** https://github.com/kiku-jw/tas
- **SDKs:** Python and Node.js available
- **Issues:** GitHub Issues
- **Email:** support@tas.fly.dev

## API Versioning

Current version: **v1**

All endpoints are prefixed with `/v1/`. Legacy endpoints without prefix are maintained for backward compatibility but deprecated.

Breaking changes will be announced in advance and new versions will be released with appropriate migration guides.

## Security

- HTTPS only (TLS 1.2+)
- API key authentication
- Rate limiting per key
- No PII storage (messages not logged)
- GDPR compliant

## Changelog

### v1.0.3 (Current)
- Added API versioning (/v1 prefix)
- Improved multilingual spam detection
- Enhanced URL risk analysis
- Added feedback system
- Performance optimizations

### v1.0.2
- Initial public release
- Basic spam detection
- Multi-language support

## Additional Resources

- **GitHub Repository:** https://github.com/kiku-jw/tas
- **API Documentation:** https://tas.fly.dev/docs
- **Live Demo:** https://kiku-jw.github.io/tas/
- **Python SDK:** https://github.com/kiku-jw/tas/tree/main/sdks/python
- **Node.js SDK:** https://github.com/kiku-jw/tas/tree/main/sdks/nodejs

## RapidAPI Listing Checklist

- [x] API endpoints documented
- [x] Request/response schemas defined
- [x] Code examples (Python, Node.js, cURL)
- [x] SDKs created (Python, Node.js)
- [x] Health endpoint available
- [x] Version endpoint available
- [x] Rate limits documented
- [x] Pricing tiers suggested
- [x] Use cases described
- [x] Performance metrics provided
- [x] Error handling documented
- [x] Security information included

