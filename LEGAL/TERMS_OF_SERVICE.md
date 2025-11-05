# Terms of Service

**Last Updated**: 2025-01-15  
**Effective Date**: 2025-01-15

## 1. Acceptance of Terms

By accessing or using the TAS (Transmodal Anti-Spam) API ("Service"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, do not use the Service.

## 2. Description of Service

TAS provides a commercial anti-spam API service for detecting spam in text messages. The Service includes:
- Rules-based spam detection
- Optional LLM-assisted classification
- Batch processing capabilities
- Multiple LLM modes (Managed, BYO, Rules-only)

## 3. API Usage and Limits

### Free Tier
- 1,000 requests per month
- 2 requests per second
- Rules-only mode (no LLM)
- Subject to rate limiting

### Paid Tiers
- Usage limits as specified in your plan
- Overage charges apply (+20% to CPM)
- LLM usage limits enforced automatically

## 4. Data Privacy

### PII Redaction
- Personal Identifiable Information (PII) is automatically redacted from logs
- Email addresses, phone numbers, URLs, IP addresses are redacted
- API keys are hashed for tracking (never stored in plain text)

### Data Retention
- Default retention: 7 days
- Option for 0-day retention (immediate deletion)
- Raw text content deleted after classification
- Only aggregated metrics and signatures retained

### BYO Mode
- Your LLM provider credentials are never logged or stored
- Only a hash identifier is stored for session tracking
- Credentials used only for the specific request and discarded

## 5. Acceptable Use

You agree not to:
- Use the Service for illegal purposes
- Attempt to reverse engineer or compromise the Service
- Exceed rate limits or attempt to circumvent them
- Use the Service to spam or harass others
- Share API keys with unauthorized parties

## 6. Service Level Agreement (SLA)

### Uptime
- **Starter/Growth/Pro**: 99.5% uptime
- **Enterprise**: 99.9% uptime

### Performance Targets
- P95 latency (rules-only): ≤ 250ms
- P95 latency (with LLM): ≤ 750ms
- Error rate: ≤ 0.5%

### Remedy
If SLA is not met, eligible customers may receive service credits as specified in their plan.

## 7. Payment and Billing

- Billing is monthly in advance
- Overage charges billed at end of month
- Automatic payment required
- Refunds: Pro-rated for unused portion of month if cancelled

## 8. Intellectual Property

### Service License
- Service code, rules, and heuristics: **BUSL-1.1**
- Change Date: 2028-01-01
- No competing SaaS hosting allowed

### SDK License
- SDKs (Python, Node.js, Go): **Apache-2.0**
- OpenAPI specification: **Apache-2.0**
- Documentation: **Apache-2.0**

## 9. Limitation of Liability

THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND. WE SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES ARISING FROM USE OF THE SERVICE.

## 10. Termination

Either party may terminate service with 30 days notice. Upon termination:
- API access is immediately revoked
- Data is deleted per retention policy
- No refunds for unused time

## 11. Changes to Terms

We reserve the right to modify these Terms. Material changes will be communicated via email 30 days in advance.

## 12. Contact

For questions about these Terms, contact: legal@tas-api.com

---

**License**: BUSL-1.1 (Service), Apache-2.0 (SDKs/Docs)

