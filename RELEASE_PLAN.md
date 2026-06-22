# TAS Release Plan - D0 → D+3

**Date**: 2025-01-15  
**Target**: RapidAPI publication today, post-launch review D+3

## D0 (Today) - Publication

### ✅ 1. RapidAPI Sandbox 13/13
- [ ] Fix remaining 2 sandbox test scenarios
- [ ] Verify all: 200/400/401/413/429/5xx, batch 100 items, legacy/new fields
- [ ] Run full smoke test suite

### ✅ 2. RapidAPI Card Updates
- [ ] Update KPI: FPR 4.8%, Recall 76.2%, P95 198/687ms, LLM 12.3%
- [ ] Update Pricing: Free (1k/mo, 2 rps, rules_only), Starter $9, Growth $49, Pro $199
- [ ] Add 3 screenshots + 1 latency GIF
- [ ] Add links: OpenAPI/SDK/Postman/Migration
- [ ] Overage: +20% to CPM

### ✅ 3. GitHub Pages Setup
- [ ] Enable Pages for `docs/` directory
- [ ] Add anchors: /#quickstart, /#modes, /#pricing, /#migration, /#e2e, /#limits
- [ ] Update demo page with curl/bash examples
- [ ] Add "Try rules_only" button (no key, rate-limited)
- [ ] Add latency GIF and "Run in Postman" button

### ✅ 4. Monitoring & Budgets (Production)
- [ ] Prometheus/Grafana dashboard: SLO metrics
- [ ] Alerts: LLM-hit > 20%, p95 > thresholds, error-rate > 0.5%, spend > budget
- [ ] Uptime ping from 2 regions
- [ ] Static /status page

### ✅ 5. Runbooks
- [ ] LLM outage runbook
- [ ] Cost spike runbook
- [ ] Blue/Green deployment process

### ✅ 6. SDK Examples
- [ ] Python: Managed/BYO/Rules-only examples
- [ ] Node.js: Managed/BYO/Rules-only examples
- [ ] Go: Managed/BYO/Rules-only examples

### ✅ 7. Mini Landing Page
- [ ] One-pager on Pages
- [ ] Hero, Why, How, Modes, Pricing, SDKs, Status
- [ ] CTA "Try on RapidAPI"

### ✅ 8. Commercial Hygiene
- [ ] ToS/Privacy: PII redaction, retention, BYO keys
- [ ] Licenses: SDK Apache-2.0, Service BUSL-1.1
- [ ] Versioning: v1 frozen 12 months

### ✅ 9. Smoke Tests (Post-Publication)
- [ ] healthz endpoint
- [ ] classify endpoint (spam detection)
- [ ] batch endpoint (5 mixed items)

## D+3 (Post-Launch Review)

### ✅ 10. Post-Launch Report
- [ ] Paying users/activations
- [ ] p95/p99 metrics
- [ ] LLM-hit-rate, cache-hit
- [ ] FPR/Recall on early sample
- [ ] Daily spend
- [ ] Top FP/FN reasons
- [ ] Pricing recommendations

## Status

- **Current**: Starting execution
- **Target**: D0 publication today
- **Review**: D+3 post-launch analysis

