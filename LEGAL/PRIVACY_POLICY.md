# Privacy Policy

**Last Updated**: 2025-01-15  
**Effective Date**: 2025-01-15

## 1. Data We Collect

### API Requests
- Text content (for classification)
- Language code
- Optional: sender_id, message_id
- API key (hashed for tracking)

### Logs
- Request timestamps
- Response codes
- Latency metrics
- Error messages (PII redacted)

### Metrics
- Aggregated performance metrics
- Cache hit rates
- LLM usage statistics
- No individual message content stored

## 2. How We Use Data

### Service Provision
- Classify messages for spam detection
- Improve detection accuracy
- Monitor service performance

### Analytics
- Aggregate usage statistics
- Performance optimization
- Quality metrics (FPR, Recall, etc.)

### Security
- Detect abuse and rate limit violations
- Prevent unauthorized access
- Monitor for malicious activity

## 3. Data Protection

### PII Redaction
- **Automatic**: Email addresses, phone numbers, URLs, IP addresses redacted from logs
- **Default**: Enabled for all requests
- **Configuration**: Can be disabled per request (not recommended)

### Encryption
- Data in transit: TLS 1.2+
- Data at rest: Encrypted (configurable)

### Access Controls
- Role-based access to data
- API keys required for all requests
- Audit logs for data access

## 4. Data Retention

### Default: 7 Days
- Request logs: 7 days
- Aggregated metrics: 30 days
- Error logs: 7 days

### Option: 0 Days
- Immediate deletion after classification
- Available for privacy-sensitive deployments
- Configure via environment variable

### What We Retain
- **Aggregated metrics**: Performance statistics, usage patterns
- **Signatures**: Hashed message signatures (for duplicate detection)
- **No raw text**: Original message content never stored

## 5. BYO Mode Privacy

When using BYO (Bring Your Own) mode:
- **Your LLM credentials**: Never logged or stored
- **Only hash identifier**: Stored for session tracking
- **Temporary use**: Credentials used only for the request and discarded
- **No data sharing**: Your data never sent to TAS-managed LLM providers

## 6. Data Sharing

We do not:
- Sell your data to third parties
- Share data with advertisers
- Use data for marketing purposes

We may share:
- Aggregated, anonymized statistics (for industry reports)
- With your explicit consent
- As required by law

## 7. Your Rights

### Access
- Request access to your data
- Export your usage statistics
- View your API key metadata

### Deletion
- Request immediate deletion of your data
- Configure 0-day retention
- Cancel account and data deletion

### Correction
- Update API key metadata
- Correct billing information
- Update account settings

## 8. Security Measures

- **Encryption**: TLS in transit, encryption at rest
- **Access Controls**: API key authentication, role-based access
- **Monitoring**: 24/7 security monitoring
- **Incident Response**: Security incident response plan

## 9. Children's Privacy

Service is not intended for users under 18. We do not knowingly collect data from children.

## 10. International Data Transfers

- Data processed in multiple regions
- Compliant with GDPR, CCPA
- Data residency options available (Enterprise)

## 11. Changes to Privacy Policy

Material changes will be communicated via email 30 days in advance.

## 12. Contact

For privacy questions or requests:
- Email: privacy@tas-api.com
- Data Protection Officer: dpo@tas-api.com

---

**Compliance**: GDPR, CCPA, SOC 2 (in progress)

