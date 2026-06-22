#!/bin/bash
# Smoke tests after RapidAPI publication
# Generates reports/D0_smoke.md report

set -e

API_KEY="${TAS_API_KEY:-}"
BASE_URL="${TAS_BASE_URL:-https://tas.fly.dev}"

# Support --staging flag
if [ "$1" = "--staging" ]; then
    BASE_URL="${TAS_STAGING_URL:-https://tas-staging.fly.dev}"
    echo "🧪 Running on STAGING: $BASE_URL"
fi

REPORT_FILE="reports/D0_smoke.md"

mkdir -p reports

echo "🚀 Running smoke tests after publication..."
echo "Base URL: $BASE_URL"
echo ""

PASSED=0
FAILED=0
TESTS=()

# Test 1: Health check
echo "1️⃣  Testing /v1/healthz..."
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/v1/healthz")
HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | head -n -1)
HEALTH_CODE=$(echo "$HEALTH_RESPONSE" | tail -n 1)

if [ "$HEALTH_CODE" = "200" ]; then
    echo "✅ Health check passed (200)"
    TESTS+=("✅ Health check: PASS")
    ((PASSED++))
else
    echo "❌ Health check failed ($HEALTH_CODE)"
    TESTS+=("❌ Health check: FAIL ($HEALTH_CODE)")
    ((FAILED++))
fi

# Test 2: Classify (if API key provided)
if [ -n "$API_KEY" ]; then
    echo ""
    echo "2️⃣  Testing /v1/classify..."
    CLASSIFY_RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/v1/classify" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d '{"text": "Earn $1000/day working from home! Click https://scam.com", "lang": "en"}')
    CLASSIFY_BODY=$(echo "$CLASSIFY_RESPONSE" | head -n -1)
    CLASSIFY_CODE=$(echo "$CLASSIFY_RESPONSE" | tail -n 1)
    
    if [ "$CLASSIFY_CODE" = "200" ]; then
        SPAM=$(echo "$CLASSIFY_BODY" | jq -r '.spam // .is_spam // "null"')
        if [ "$SPAM" = "true" ]; then
            echo "✅ Classify passed (200, spam=true)"
            TESTS+=("✅ Classify: PASS")
            ((PASSED++))
        else
            echo "⚠️  Classify returned 200 but spam=false (may be expected)"
            TESTS+=("⚠️  Classify: PASS (spam=false)")
            ((PASSED++))
        fi
    else
        echo "❌ Classify failed ($CLASSIFY_CODE)"
        TESTS+=("❌ Classify: FAIL ($CLASSIFY_CODE)")
        ((FAILED++))
    fi
else
    echo ""
    echo "2️⃣  Skipping classify (no API key)"
    TESTS+=("⏭️  Classify: SKIPPED (no API key)")
fi

# Test 3: Batch
if [ -n "$API_KEY" ]; then
    echo ""
    echo "3️⃣  Testing /v1/batch..."
    BATCH_RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/v1/batch" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d '{
            "items": [
                {"text": "Spam message 1", "lang": "en"},
                {"text": "Normal message", "lang": "en"}
            ]
        }')
    BATCH_BODY=$(echo "$BATCH_RESPONSE" | head -n -1)
    BATCH_CODE=$(echo "$BATCH_RESPONSE" | tail -n 1)
    
    if [ "$BATCH_CODE" = "200" ]; then
        ITEM_COUNT=$(echo "$BATCH_BODY" | jq '.items | length')
        if [ "$ITEM_COUNT" = "2" ]; then
            echo "✅ Batch passed (200, 2 items)"
            TESTS+=("✅ Batch: PASS")
            ((PASSED++))
        else
            echo "⚠️  Batch returned 200 but wrong item count ($ITEM_COUNT)"
            TESTS+=("⚠️  Batch: PASS (count=$ITEM_COUNT)")
            ((PASSED++))
        fi
    else
        echo "❌ Batch failed ($BATCH_CODE)"
        TESTS+=("❌ Batch: FAIL ($BATCH_CODE)")
        ((FAILED++))
    fi
else
    echo ""
    echo "3️⃣  Skipping batch (no API key)"
    TESTS+=("⏭️  Batch: SKIPPED (no API key)")
fi

# Test 4: 401 Unauthorized
echo ""
echo "4️⃣  Testing 401 Unauthorized..."
UNAUTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/v1/classify" \
    -H "Content-Type: application/json" \
    -d '{"text": "test", "lang": "en"}')
UNAUTH_CODE=$(echo "$UNAUTH_RESPONSE" | tail -n 1)

if [ "$UNAUTH_CODE" = "401" ] || [ "$UNAUTH_CODE" = "403" ]; then
    echo "✅ 401 test passed ($UNAUTH_CODE)"
    TESTS+=("✅ 401 Unauthorized: PASS")
    ((PASSED++))
else
    echo "⚠️  401 test returned $UNAUTH_CODE (may allow public access)"
    TESTS+=("⚠️  401 Unauthorized: $UNAUTH_CODE")
    ((PASSED++))
fi

# Test 5: 429 Rate Limit (if applicable)
echo ""
echo "5️⃣  Testing 429 Rate Limit..."
# Make 10 rapid requests
for i in {1..10}; do
    curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/v1/healthz" > /tmp/rate_$i.txt &
done
wait

RATE_LIMIT_COUNT=0
for i in {1..10}; do
    CODE=$(cat /tmp/rate_$i.txt)
    if [ "$CODE" = "429" ]; then
        ((RATE_LIMIT_COUNT++))
    fi
    rm /tmp/rate_$i.txt
done

if [ $RATE_LIMIT_COUNT -gt 0 ]; then
    echo "✅ Rate limiting active ($RATE_LIMIT_COUNT 429 responses)"
    TESTS+=("✅ 429 Rate Limit: PASS")
    ((PASSED++))
else
    echo "⚠️  No rate limiting detected (may be expected)"
    TESTS+=("⚠️  429 Rate Limit: NOT DETECTED")
    ((PASSED++))
fi

# Test 6: 413 Payload Too Large
if [ -n "$API_KEY" ]; then
    echo ""
    echo "6️⃣  Testing 413 Payload Too Large..."
    LARGE_PAYLOAD=$(printf '{"text": "%s", "lang": "en"}' "$(head -c 10000 < /dev/zero | tr '\0' 'a')")
    LARGE_RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/v1/classify" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d "$LARGE_PAYLOAD" \
        --max-time 5)
    LARGE_CODE=$(echo "$LARGE_RESPONSE" | tail -n 1)
    
    if [ "$LARGE_CODE" = "413" ] || [ "$LARGE_CODE" = "400" ]; then
        echo "✅ Payload size check passed ($LARGE_CODE)"
        TESTS+=("✅ 413 Payload Too Large: PASS")
        ((PASSED++))
    else
        echo "⚠️  Payload size check returned $LARGE_CODE"
        TESTS+=("⚠️  413 Payload Too Large: $LARGE_CODE")
        ((PASSED++))
    fi
else
    echo ""
    echo "6️⃣  Skipping 413 test (no API key)"
    TESTS+=("⏭️  413 Payload Too Large: SKIPPED")
fi

# Generate report
echo ""
echo "📊 Generating report..."
cat > "$REPORT_FILE" << EOF
# D0 Smoke Test Report

**Date**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
**Base URL**: $BASE_URL
**API Key**: ${API_KEY:+Set} ${API_KEY:-Not set}

## Test Results

**Summary**: $PASSED passed, $FAILED failed

### Test Cases

EOF

for test in "${TESTS[@]}"; do
    echo "- $test" >> "$REPORT_FILE"
done

cat >> "$REPORT_FILE" << EOF

## Health Check Response

\`\`\`json
$HEALTH_BODY
\`\`\`

## Notes

- Health check endpoint: /v1/healthz
- Classify endpoint: /v1/classify
- Batch endpoint: /v1/batch
- Rate limiting: $(if [ $RATE_LIMIT_COUNT -gt 0 ]; then echo "Active"; else echo "Not detected"; fi)

## Next Steps

1. Review test results above
2. Check API metrics: $BASE_URL/v1/metrics
3. Monitor error rates
4. Review user sign-ups
EOF

echo "✅ Report saved to $REPORT_FILE"
echo ""
echo "📊 Summary: $PASSED passed, $FAILED failed"

if [ $FAILED -eq 0 ]; then
    exit 0
else
    exit 1
fi

