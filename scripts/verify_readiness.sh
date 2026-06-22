#!/bin/bash
# Verify TAS readiness for production launch
# Checks all critical components and configurations

set -e

echo "🔍 TAS Production Readiness Check"
echo "=================================="
echo ""

ERRORS=0
WARNINGS=0

# Check 1: Code structure
echo "1️⃣  Checking code structure..."
if [ -f "app/main.py" ] && [ -f "app/pipeline.py" ] && [ -f "app/config.py" ]; then
    echo "   ✅ Core modules present"
else
    echo "   ❌ Missing core modules"
    ((ERRORS++))
fi

# Check 2: Tests
echo ""
echo "2️⃣  Checking tests..."
if [ -d "tests" ] && [ -f "tests/test_sandbox_scenarios.py" ]; then
    TEST_COUNT=$(find tests -name "test_*.py" | wc -l | tr -d ' ')
    echo "   ✅ Test files found: $TEST_COUNT"
else
    echo "   ⚠️  Tests directory or sandbox tests missing"
    ((WARNINGS++))
fi

# Check 3: Documentation
echo ""
echo "3️⃣  Checking documentation..."
REQUIRED_DOCS=(
    "README.md"
    "docs/index.html"
    "docs/status.html"
    "RAPIDAPI_CARD.md"
    "openapi.yaml"
    "postman_collection.json"
    "docs/LLM_MODES.md"
)

MISSING_DOCS=0
for doc in "${REQUIRED_DOCS[@]}"; do
    if [ ! -f "$doc" ]; then
        echo "   ❌ Missing: $doc"
        ((MISSING_DOCS++))
    fi
done

if [ $MISSING_DOCS -eq 0 ]; then
    echo "   ✅ All documentation files present"
else
    echo "   ❌ Missing $MISSING_DOCS documentation files"
    ((ERRORS++))
fi

# Check 4: Monitoring config
echo ""
echo "4️⃣  Checking monitoring configuration..."
if [ -f "monitoring/prometheus.yml" ] && [ -f "monitoring/alerts.yml" ]; then
    echo "   ✅ Prometheus config present"
    echo "   ✅ Alert rules present"
else
    echo "   ❌ Missing monitoring config"
    ((ERRORS++))
fi

if [ -f "monitoring/grafana_dashboard.json" ]; then
    echo "   ✅ Grafana dashboard present"
else
    echo "   ⚠️  Grafana dashboard missing (optional)"
    ((WARNINGS++))
fi

# Check 5: Runbooks
echo ""
echo "5️⃣  Checking runbooks..."
RUNBOOKS=(
    "runbooks/LLM_OUTAGE.md"
    "runbooks/COST_SPIKE.md"
    "runbooks/BLUE_GREEN.md"
)

MISSING_RUNBOOKS=0
for runbook in "${RUNBOOKS[@]}"; do
    if [ ! -f "$runbook" ]; then
        echo "   ❌ Missing: $runbook"
        ((MISSING_RUNBOOKS++))
    fi
done

if [ $MISSING_RUNBOOKS -eq 0 ]; then
    echo "   ✅ All runbooks present"
else
    echo "   ❌ Missing $MISSING_RUNBOOKS runbooks"
    ((ERRORS++))
fi

# Check 6: SDKs
echo ""
echo "6️⃣  Checking SDKs..."
SDK_DIRS=("sdks/python" "sdks/nodejs" "sdks/go")
MISSING_SDKS=0

for sdk in "${SDK_DIRS[@]}"; do
    if [ -d "$sdk" ]; then
        echo "   ✅ $sdk present"
    else
        echo "   ⚠️  $sdk missing (optional)"
        ((MISSING_SDKS++))
        ((WARNINGS++))
    fi
done

# Check 7: Legal docs
echo ""
echo "7️⃣  Checking legal documentation..."
if [ -d "LEGAL" ] && [ -f "LEGAL/TERMS_OF_SERVICE.md" ] && [ -f "LEGAL/PRIVACY_POLICY.md" ]; then
    echo "   ✅ Legal documentation present"
else
    echo "   ⚠️  Legal documentation missing (optional for MVP)"
    ((WARNINGS++))
fi

# Check 8: Scripts
echo ""
echo "8️⃣  Checking scripts..."
REQUIRED_SCRIPTS=(
    "scripts/smoke_test_prod.sh"
    "scripts/check_pages.sh"
)

MISSING_SCRIPTS=0
for script in "${REQUIRED_SCRIPTS[@]}"; do
    if [ -f "$script" ] && [ -x "$script" ]; then
        echo "   ✅ $script (executable)"
    elif [ -f "$script" ]; then
        echo "   ⚠️  $script (not executable)"
        ((WARNINGS++))
    else
        echo "   ❌ Missing: $script"
        ((MISSING_SCRIPTS++))
    fi
done

if [ $MISSING_SCRIPTS -eq 0 ]; then
    echo "   ✅ All required scripts present"
else
    echo "   ❌ Missing $MISSING_SCRIPTS scripts"
    ((ERRORS++))
fi

# Check 9: GitHub Pages
echo ""
echo "9️⃣  Checking GitHub Pages..."
if curl -s -o /dev/null -w "%{http_code}" https://kiku-jw.github.io/tas/ | grep -q "200"; then
    echo "   ✅ GitHub Pages accessible"
else
    echo "   ⚠️  GitHub Pages not yet deployed (may need manual setup)"
    echo "      URL: https://github.com/kiku-jw/tas/settings/pages"
    ((WARNINGS++))
fi

# Check 10: API endpoint (if API key available)
echo ""
echo "🔟 Checking API endpoint..."
if [ -n "$TAS_API_KEY" ]; then
    HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" https://tas.fly.dev/v1/healthz 2>/dev/null || echo "000")
    if [ "$HEALTH_CODE" = "200" ]; then
        echo "   ✅ API endpoint responding (200)"
    else
        echo "   ⚠️  API endpoint not responding ($HEALTH_CODE)"
        echo "      Set TAS_API_KEY to test authenticated endpoints"
        ((WARNINGS++))
    fi
else
    echo "   ⚠️  TAS_API_KEY not set, skipping API check"
    echo "      Set TAS_API_KEY to test authenticated endpoints"
    ((WARNINGS++))
fi

# Summary
echo ""
echo "=================================="
echo "📊 Summary"
echo "=================================="
echo ""

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo "✅ All checks passed! Ready for production."
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo "⚠️  $WARNINGS warning(s) found. Review and address before launch."
    echo "   Most warnings are optional or require manual setup."
    exit 0
else
    echo "❌ $ERRORS error(s) and $WARNINGS warning(s) found."
    echo "   Please fix errors before launching."
    exit 1
fi

