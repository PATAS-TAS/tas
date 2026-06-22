# Runbook: Cost Spike

## Scenario
LLM costs are exceeding daily budget or trending upward unexpectedly.

## Symptoms
- Daily LLM spend > 80% of budget
- LLM hit rate > 20%
- Cache hit rate < 50%
- Cost per request increasing

## Immediate Actions

### 1. Reduce LLM Usage
```bash
# Option A: Reduce LLM share to 5%
# Update decision threshold to be more aggressive
export DECISION_THRESHOLD=0.45  # Higher threshold = fewer LLM calls

# Option B: Enable stricter short-circuit
# Already implemented: if rules-score > 0.8, skip LLM
```

### 2. Optimize LLM Parameters
```python
# In app/llm_check.py, reduce max_tokens
max_tokens = 50  # Reduced from 80
```

### 3. Increase Cache TTL
```bash
export LLM_CACHE_TTL=172800  # 48 hours instead of 24
```

### 4. Enable Per-Tenant Throttling
```python
# Throttle LLM calls per API key
# Implement rate limiting: max 10% LLM calls per tenant
```

## Medium-Term Actions

### 1. Analyze High-Usage Tenants
```sql
SELECT 
    api_key_hash,
    COUNT(*) as total_requests,
    SUM(CASE WHEN path = 'llm' THEN 1 ELSE 0 END) as llm_requests,
    SUM(CASE WHEN path = 'llm' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as llm_percentage
FROM requests
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY api_key_hash
HAVING llm_percentage > 15
ORDER BY llm_requests DESC;
```

### 2. Contact High-Usage Tenants
- Suggest optimizing requests (use rules-only mode)
- Recommend upgrading to Pro plan (higher LLM limits)
- Provide guidance on reducing LLM usage

### 3. Review Pricing
- Consider adjusting overage rates
- Evaluate if free tier should remain rules-only
- Update pricing tiers if needed

## Long-Term Actions

### 1. Improve Cache Effectiveness
- Analyze cache hit rate by tenant
- Identify patterns that could improve caching
- Consider implementing Redis for distributed cache

### 2. Optimize Rules
- Expand ruleset to cover more edge cases
- Reduce dependency on LLM for common patterns
- Improve early-exit logic (currently: rules-score > 0.8)

### 3. Cost Monitoring Dashboard
- Set up Grafana alerts:
  - `spend_today > budget * 0.8` → Warning
  - `spend_today > budget` → Critical (auto-degrade)
- Daily cost reports
- Per-tenant cost breakdown

## Auto-Degrade Configuration

```python
# In app/main.py or config
DAILY_LLM_BUDGET = 25.0  # USD
LLM_BUDGET_ALERT_THRESHOLD = 0.8  # Alert at 80%
LLM_BUDGET_AUTO_DEGRADE = 1.0  # Auto-degrade at 100%

# Check in metrics or middleware
if daily_spend > LLM_BUDGET_AUTO_DEGRADE * DAILY_LLM_BUDGET:
    # Force rules-only for new requests
    llm_mode = "rules_only"
```

## Rollback Plan

If cost measures are too aggressive:
1. Gradually increase LLM share (5% → 10% → 15%)
2. Monitor FPR/Recall - ensure quality doesn't degrade
3. Adjust thresholds based on actual costs vs. budget

## Contacts

- **Finance Team**: [Contact]
- **Product Team**: [Contact]
- **On-Call Engineer**: [Contact]

