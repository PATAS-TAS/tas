# Runbook: Blue/Green Deployment

## Scenario
Rolling out new ruleset version or API changes with zero-downtime deployment.

## Process

### 1. Preparation
- New version tagged and tested
- Ruleset version incremented
- Health checks passing

### 2. Canary Deployment (10% Traffic)

```bash
# Set canary percentage
export CANARY_PERCENTAGE=10

# Deploy new version to canary instances
# Traffic routing: 10% to canary, 90% to stable
```

### 3. Monitor Canary (24 Hours)

**Metrics to Watch:**
- FPR: Should remain ≤ 5%
- Recall: Should remain ≥ 75%
- Error rate: Should remain < 0.5%
- Latency: P95 should remain within SLO

**Shadow Rules (if applicable):**
- New rules tested in shadow mode (no blocking)
- Precision/Recall tracked per rule
- Auto-promotion if stable for 48 hours

### 4. Gradual Rollout

**Phase 1: 10% (24 hours)**
- Monitor metrics
- Check for FP/FN increases
- Review shadow rule performance

**Phase 2: 50% (12 hours)**
- If metrics stable, increase to 50%
- Continue monitoring

**Phase 3: 100% (12 hours)**
- Full rollout if all metrics green
- Old version remains available for quick rollback

### 5. Auto-Promotion Criteria

New ruleset is auto-promoted if:
- FPR ≤ 5% for 48 hours
- Recall ≥ 75% for 48 hours
- Error rate < 0.5% for 48 hours
- No critical FP/FN reports

### 6. Rollback Plan

**Immediate Rollback Triggers:**
- FPR > 6% for 1 hour
- Recall < 70% for 1 hour
- Error rate > 1% for 30 minutes
- Critical bug reports

**Rollback Process:**
```bash
# Switch traffic back to stable version
export CANARY_PERCENTAGE=0

# Verify rollback
curl https://tas.fly.dev/v1/health
# Should show old ruleset_version
```

## Configuration

### Environment Variables
```bash
# Canary percentage (0-100)
CANARY_PERCENTAGE=10

# Ruleset version
RULESET_VERSION=1.0.4

# Auto-promotion enabled
AUTO_PROMOTE_ENABLED=true
AUTO_PROMOTE_MIN_HOURS=48
```

### Health Check Response
```json
{
  "status": "ok",
  "version": "1.0.3",
  "ruleset_version": "1.0.4",
  "canary_percentage": 10,
  "llm_status": "UP"
}
```

## Monitoring

### Grafana Dashboard
- Canary vs Stable metrics comparison
- FPR/Recall trends
- Error rate comparison
- Latency comparison

### Alerts
- `canary_fpr > 6%` → Alert, consider rollback
- `canary_error_rate > 1%` → Immediate rollback
- `canary_recall < 70%` → Alert, consider rollback

## Best Practices

1. **Always Test in Shadow First**: New rules should be tested in shadow mode
2. **Gradual Rollout**: Never jump from 10% to 100% immediately
3. **Monitor Closely**: First 24 hours are critical
4. **Have Rollback Plan**: Always keep previous version available
5. **Document Changes**: Track what changed in new ruleset

## Contacts

- **DevOps Team**: [Contact]
- **QA Team**: [Contact]
- **On-Call Engineer**: [Contact]

