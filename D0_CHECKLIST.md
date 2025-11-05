# D0 Release Checklist - Today

**Date**: 2025-01-15  
**Status**: ⏳ In Progress

## ✅ Automated (Completed)

- [x] Sandbox tests 13/13 passing
- [x] Code with auto-degrade logic
- [x] Documentation with all anchors
- [x] Runbooks created
- [x] Smoke test script ready
- [x] Monitoring config ready
- [x] Status page created
- [x] D+3 report template ready

## 🔧 Manual Actions Required

### 1. GitHub Pages (5 minutes)

**Steps:**
1. Go to: https://github.com/kiku-jw/tas/settings/pages
2. Source: Deploy from branch
3. Branch: `main`
4. Folder: `/docs`
5. Click "Save"
6. Wait 5-10 minutes for deployment

**Verify:**
```bash
./scripts/check_pages.sh
```

**Expected URLs:**
- https://kiku-jw.github.io/tas/ (main page)
- https://kiku-jw.github.io/tas/#quickstart
- https://kiku-jw.github.io/tas/#modes
- https://kiku-jw.github.io/tas/#pricing
- https://kiku-jw.github.io/tas/#migration
- https://kiku-jw.github.io/tas/#limits
- https://kiku-jw.github.io/tas/status.html

### 2. RapidAPI Card Submission (15 minutes)

**Content Source:** `RAPIDAPI_CARD.md`

**Steps:**
1. Login to RapidAPI
2. Create new API listing
3. Fill in:
   - Title: "TAS — Fast & Safe Commercial Anti-Spam API"
   - Description: From `RAPIDAPI_CARD.md`
   - KPI Metrics: FPR 4.8%, Recall 76.2%, P95 198/687ms
4. Upload screenshots (3):
   - Demo page screenshot
   - API response example
   - Latency graph (static or GIF)
5. Upload GIF: Latency trends over time
6. Set pricing:
   - Free: 1k/mo, 2 rps, rules_only
   - Starter: $9/mo, 50k req, LLM ≤ 5%
   - Growth: $49/mo, 500k req, LLM ≤ 10%
   - Pro: $199/mo, 3M req, LLM ≤ 15%
   - Overage: +20% to CPM
7. Add links:
   - OpenAPI: `https://github.com/kiku-jw/tas/blob/main/tas/openapi.yaml`
   - Postman: `https://github.com/kiku-jw/tas/blob/main/tas/postman_collection.json`
   - Docs: `https://kiku-jw.github.io/tas/`
   - Migration: `https://kiku-jw.github.io/tas/#migration`
8. Submit for review

### 3. Smoke Tests (5 minutes)

**Staging:**
```bash
cd /Users/nick/myprojects/Cursor/PATAS/tas
./scripts/smoke_test_prod.sh "" https://tas-staging.fly.dev "" true
```

**Production (after RapidAPI approval):**
```bash
./scripts/smoke_test_prod.sh $TAS_API_KEY https://tas.fly.dev
```

**Expected:**
- ✅ healthz → 200, llm_status = UP/DOWN/DEGRADED
- ✅ classify → spam=true, path=rules, request_id present
- ✅ batch → 5 ordered results with request_id

### 4. Monitoring Setup (20 minutes)

**Prometheus:**
1. Deploy Prometheus (or use managed service)
2. Add scrape config from `monitoring/prometheus.yml`
3. Target: `https://tas.fly.dev/v1/metrics`

**Grafana:**
1. Import dashboard from `monitoring/grafana_dashboard.json`
2. Connect to Prometheus data source
3. Verify all panels show data

**Alerts:**
1. Import alert rules from `monitoring/alerts.yml`
2. Configure routing:
   - Warning → Slack/Email
   - Critical → PagerDuty/Phone
3. Test alerts

**Uptime Monitoring:**
1. Set up ping from 2 regions (e.g., US-East, EU-West)
2. Monitor: `https://tas.fly.dev/v1/healthz`
3. Alert if down > 1 minute

### 5. Budget Auto-Degrade (5 minutes)

**Configuration:**
```bash
# Set daily budget (default: $25/day)
export LLM_DAILY_BUDGET=25.0

# Or via CLI
tas budget --daily 25.0
```

**Verify:**
- Auto-degrade enabled when `spend_today > budget`
- Auto-degrade enabled when `LLM-hit-rate > 20%` for 10+ minutes
- Check logs for "forcing rules_only" messages

**Test:**
```bash
# Simulate budget exceeded
tas budget --daily 0.01
# Make some requests
# Should see logs: "Budget exceeded, forcing rules_only mode"
```

### 6. Status Page (2 minutes)

**Deploy:**
- File: `docs/status.html`
- URL: `https://kiku-jw.github.io/tas/status.html`
- Auto-updates via Pages deployment

**Verify:**
- Accessible at status URL
- Shows current SLO metrics
- Incident log empty (hopefully!)

### 7. Documentation Links Check (2 minutes)

**Verify absolute URLs:**
- [x] Link header: `https://kiku-jw.github.io/tas/#migration` ✅
- [x] Link header: `https://kiku-jw.github.io/tas/#modes` ✅
- [ ] Pages deployed and accessible
- [ ] All anchors work

**Command:**
```bash
./scripts/check_pages.sh
```

### 8. D+3 Task Creation (1 minute)

**Create task/reminder:**
- Fill `reports/D3_REPORT_TEMPLATE.md` in 72 hours
- Collect: activations, paying users, metrics, costs, FP/FN
- Generate recommendations

**Calendar/Reminder:**
- Date: [LAUNCH_DATE + 3 days]
- Action: Fill D+3 report template

## 📊 Post-Publication Monitoring

### First 24 Hours
- [ ] Monitor error rates
- [ ] Check latency (P95 rules < 250ms, LLM < 750ms)
- [ ] Verify LLM hit rate < 15%
- [ ] Check budget utilization
- [ ] Review user sign-ups

### First 72 Hours
- [ ] Collect metrics for D+3 report
- [ ] Analyze FP/FN patterns
- [ ] Review pricing feedback
- [ ] Check conversion rates

## 🚨 Rollback Triggers

**Immediate Rollback if:**
- Error rate > 0.5% for 5 minutes
- P95 rules > 250ms for 10 minutes
- P95 LLM > 750ms for 10 minutes
- Critical security issue

**Actions:**
1. Scale out instances
2. Warm up connections
3. If persists: temporary rules_only mode
4. Check runbooks for specific scenarios

## ✅ Final Verification

Before marking as complete:
- [ ] Pages accessible
- [ ] RapidAPI card submitted
- [ ] Smoke tests pass (staging + prod)
- [ ] Monitoring active
- [ ] Alerts configured
- [ ] Budget auto-degrade enabled
- [ ] Status page live
- [ ] D+3 task created

---

**Next Update**: After Pages deployment and RapidAPI submission

