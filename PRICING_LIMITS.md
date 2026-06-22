# Pricing & Limits

## Plans

### Free
- **1,000 requests/month** (promo: 3,000 requests/month for first 60 days)
- Rules-only classification (no LLM fallback)
- Rate limit: 2 requests/second
- Perfect for testing and small projects

### Starter - $9/month
- **50,000 requests/month**
- LLM fallback up to 10% of requests
- Overage: $2 per 10,000 additional requests
- Rate limit: 10 requests/second
- Email support

### Pro - $49/month
- **500,000 requests/month**
- LLM fallback up to 15% of requests
- Overage: $1.5 per 10,000 additional requests
- Rate limit: 50 requests/second
- Priority support
- SLA: 99.5% uptime

### Enterprise
- Custom volume and pricing
- Dedicated instances
- SLA: 99.9% uptime
- Custom allow/deny lists
- Multi-tenant support
- White-glove onboarding

## Launch Promo (60 days)

- **Free tier**: 3,000 requests/month (instead of 1,000)
- **Coupon START-50**: 50% off first month for Starter/Pro plans

## Rate Limits

| Plan | Requests/Second | Burst |
|------|----------------|-------|
| Free | 2 | 10 (5 sec) |
| Starter | 10 | 50 (5 sec) |
| Pro | 50 | 250 (5 sec) |
| Enterprise | Custom | Custom |

## API Limits

- **Single request**: Text length 1-8,192 characters
- **Batch request**: Up to 100 items, payload ≤ 256 KB
- **Per-item text**: ≤ 2,000 characters in batch
- **Timeout**: 10 seconds (single), 30 seconds (batch)

## Overage Billing

Overage is calculated daily and billed monthly:
- Requests exceeding monthly quota are charged at plan's overage rate
- Overage is prorated if you upgrade mid-month
- Automatic email notifications at 80% and 100% of quota

## LLM Usage Limits

LLM fallback is automatically limited to prevent cost overruns:
- **Starter**: LLM ≤ 10% of requests
- **Pro**: LLM ≤ 15% of requests
- **Enterprise**: Custom limits

If LLM usage exceeds limits, requests automatically fall back to rules-only classification.

## Data Retention

- **Default**: 7 days (logs, feedback)
- **Option**: 0 days (for privacy-sensitive deployments)
- **Cache**: 24 hours TTL (signatures only, no raw text)

## Support

- **Free**: Community support (GitHub issues)
- **Starter/Pro**: Email support (24-48h response)
- **Enterprise**: Priority support (SLA-based response times)

---

Questions? Contact us at support@tas-api.com or [GitHub Issues](https://github.com/kiku-jw/tas/issues).

