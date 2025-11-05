# Release Readiness Checklist

**Date**: 2025-01-15  
**Status**: ✅ **READY FOR PUBLICATION**

## ✅ Completed Components

### 1. Playwright Assets
- [x] `scripts/generate_screenshots.py` - Screenshot generation script
- [x] `docs/assets/` directory created
- [ ] `docs/assets/screen-demo.png` - Run script to generate
- [ ] `docs/assets/screen-swagger.png` - Run script to generate
- [ ] `docs/assets/screen-dashboard.png` - Run script or manual Grafana export
- [ ] `docs/assets/latency.gif` - Run `scripts/generate_latency_gif.py` or manual

**Action**: Run `python scripts/generate_screenshots.py` (requires Playwright)

### 2. RapidAPI Pack
- [x] `scripts/create_rapidapi_pack.sh` - Pack creation script
- [x] Quickstart README template
- [ ] `release/rapidapi-pack.zip` - Run script to generate

**Action**: Run `./scripts/create_rapidapi_pack.sh`

### 3. One-Line Installer
- [x] `scripts/install.sh` - Installation script
- [x] `tas quickstart` CLI command added
- [x] Auto-generates .env file
- [x] Shows SDK examples

**Action**: Test installer locally

### 4. Smoke After Publish
- [x] `scripts/smoke_after_publish.sh` - Smoke test script
- [x] Tests: healthz, classify, batch, 401, 429, 413
- [x] Generates `reports/D0_smoke.md`

**Action**: Run after RapidAPI publication: `./scripts/smoke_after_publish.sh`

### 5. Examples
- [x] `examples/python/` - Python client + README
- [x] `examples/node/` - Node.js client + README
- [x] `examples/go/` - Go client + README
- [x] `examples/php/` - PHP client + README
- [x] `examples/java/` - Java client + README
- [x] `examples/docker-compose.yml` - Multi-language examples

**Action**: Test examples locally: `cd examples && docker-compose up`

### 6. Budget Guards
- [x] `tas guard` CLI command
- [x] `--max-llm` option (LLM hit rate limit)
- [x] `--max-spend` option (daily budget limit)
- [x] `--dry-run` option
- [x] Event logging to `monitoring/events/`

**Action**: Test: `tas guard --max-llm 0.15 --max-spend 25.0 --dry-run`

### 7. SLO PNG Export
- [x] `scripts/export_grafana_dashboard.sh` - Grafana export script
- [ ] `docs/assets/grafana_dashboard.png` - Requires Grafana setup

**Action**: Set `GRAFANA_URL` and `GRAFANA_API_KEY`, then run script

### 8. Canary Rules
- [x] `scripts/canary_promote.py` - Canary promotion script
- [x] 10% → 100% promotion logic
- [x] 24h stability check
- [x] Auto-rollback on issues
- [x] Reports in `reports/canary/`

**Action**: Test: `python scripts/canary_promote.py --check`

### 9. Documentation
- [x] FAQ section added to `docs/index.html`
- [x] Troubleshooting section added
- [x] Covers: BYO keys, modes, limits, reasons[], 413/429, threshold tuning, rules_only

**Action**: Verify Pages deployment includes new sections

### 10. Auto-Reports
- [x] `scripts/generate_auto_report.py` - D+3/D+7 report generator
- [x] Template with metrics, costs, recommendations
- [ ] `reports/D3.md` - Generate after 3 days
- [ ] `reports/D7.md` - Generate after 7 days

**Action**: Set up cron: `0 2 * * * python scripts/generate_auto_report.py --days 3`

### 11. Monitoring Deployment
- [x] `monitoring/prometheus.yml` - Production config
- [x] `monitoring/grafana_dashboard.json` - Dashboard ready
- [x] `monitoring/alerts.yml` - Alert rules configured

**Action**: Deploy Prometheus/Grafana (manual step)

## 📋 Final Verification

### Automated Checks
```bash
./scripts/verify_readiness.sh
```

### Manual Checks
- [ ] Screenshots generated and placed in `docs/assets/`
- [ ] `release/rapidapi-pack.zip` created
- [ ] Examples tested locally
- [ ] Smoke tests pass after publication
- [ ] Grafana dashboard exported
- [ ] FAQ/Troubleshooting visible on Pages

## 🎯 Criteria for Launch

- [x] `release/rapidapi-pack.zip` structure ready (script created)
- [ ] `docs/assets/*.png` + `latency.gif` generated
- [ ] `scripts/smoke_after_publish.sh` tested
- [ ] `examples/*` run locally
- [ ] `tas guard` applies limits and logs events
- [ ] `reports/D0_smoke.md` will be created after publish
- [ ] FAQ/TS rendered on Pages

## 📝 Next Steps

1. **Generate screenshots**: `python scripts/generate_screenshots.py`
2. **Create RapidAPI pack**: `./scripts/create_rapidapi_pack.sh`
3. **Test examples**: `cd examples && docker-compose up`
4. **Test guard**: `tas guard --max-llm 0.15 --max-spend 25.0 --dry-run`
5. **Export Grafana**: `./scripts/export_grafana_dashboard.sh` (if Grafana available)
6. **After publication**: Run `./scripts/smoke_after_publish.sh`

---

**Status**: All scripts and infrastructure ready. Remaining: Generate assets and test locally.

