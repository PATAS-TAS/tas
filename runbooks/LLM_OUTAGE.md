# Runbook: LLM Outage

## Scenario
LLM provider is down or experiencing high latency/errors.

## Symptoms
- LLM API returns 5xx errors
- Circuit breaker activates (3 consecutive failures)
- High latency for LLM-assisted requests
- Error rate > 0.5%

## Immediate Actions

### 1. Switch to Rules-Only Mode
```bash
# Update environment variable
export LLM_MODE=rules_only

# Or disable LLM fallback
export LLM_FALLBACK=false
```

### 2. Verify Graceful Degradation
- All requests should return HTTP 200
- `path` field should be `"rules"`
- `mode` field should be `"rules_only"`
- `reason` field may contain `"module_error"` if LLM was attempted

### 3. Monitor Metrics
- Check Prometheus dashboard:
  - Error rate should drop to < 0.1%
  - P95 latency should drop to ~200ms
  - LLM hit rate should be 0%

### 4. Update Status Page
- Set LLM status to `DOWN` or `DEGRADED`
- Update `/status` page with outage notice

## Recovery Actions

### 1. Test LLM Provider
```bash
curl -X POST https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "test"}], "max_tokens": 5}'
```

### 2. Re-enable LLM (Staged)
```bash
# First, enable with canary (10% traffic)
export LLM_MODE=managed
export LLM_CANARY_PERCENTAGE=10

# Monitor for 1 hour
# If stable, increase to 50%, then 100%
```

### 3. Verify Circuit Breaker Reset
- Circuit breaker should automatically reset after 120 seconds
- Check logs for "Circuit breaker reset" messages

## Prevention

1. **Monitor LLM Provider Health**: Set up uptime monitoring
2. **Budget Limits**: Auto-degrade to rules-only if LLM cost exceeds budget
3. **Retry Logic**: Already implemented (3 retries with exponential backoff)
4. **Circuit Breaker**: Already implemented (3 failures → 120s cooldown)

## Rollback Plan

If LLM issues persist:
1. Keep `LLM_MODE=rules_only` until provider is stable
2. Communicate to users: "Enhanced detection temporarily unavailable"
3. Monitor FPR/Recall - may increase slightly without LLM

## Contacts

- **On-Call Engineer**: [Contact]
- **LLM Provider Support**: [OpenAI Support]
- **Status Page**: https://kiku-jw.github.io/tas/status

