#!/bin/bash
# Production smoke tests after RapidAPI publication
# Usage: ./smoke_test_prod.sh [API_KEY] [BASE_URL]

set -e

API_KEY="${1:-${TAS_API_KEY}}"
BASE_URL="${2:-https://tas.fly.dev}"

if [ -z "$API_KEY" ]; then
    echo "Error: API key required. Set TAS_API_KEY or pass as first argument."
    exit 1
fi

echo "🚀 Running production smoke tests..."
echo "Base URL: $BASE_URL"
echo ""

# Test 1: Health check
echo "1️⃣  Testing /v1/healthz..."
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/v1/healthz")
HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | head -n -1)
HEALTH_CODE=$(echo "$HEALTH_RESPONSE" | tail -n 1)

if [ "$HEALTH_CODE" = "200" ]; then
    echo "✅ Health check passed (200)"
    echo "$HEALTH_BODY" | jq '.'
    
    LLM_STATUS=$(echo "$HEALTH_BODY" | jq -r '.llm_status // "UNKNOWN"')
    echo "   LLM Status: $LLM_STATUS"
    
    if [ "$LLM_STATUS" != "UP" ] && [ "$LLM_STATUS" != "DOWN" ] && [ "$LLM_STATUS" != "DEGRADED" ]; then
        echo "⚠️  Warning: Unexpected LLM status: $LLM_STATUS"
    fi
else
    echo "❌ Health check failed: HTTP $HEALTH_CODE"
    exit 1
fi

echo ""

# Test 2: Single classification (spam)
echo "2️⃣  Testing /v1/classify (spam message)..."
SPAM_TEXT='акции -70% пишите в тг @sale_best'
CLASSIFY_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$BASE_URL/v1/classify" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"$SPAM_TEXT\", \"lang\": \"ru\"}")

CLASSIFY_BODY=$(echo "$CLASSIFY_RESPONSE" | head -n -1)
CLASSIFY_CODE=$(echo "$CLASSIFY_RESPONSE" | tail -n 1)

if [ "$CLASSIFY_CODE" = "200" ]; then
    echo "✅ Classification request successful (200)"
    
    SPAM=$(echo "$CLASSIFY_BODY" | jq -r '.spam // .is_spam // false')
    PATH_FIELD=$(echo "$CLASSIFY_BODY" | jq -r '.path // "unknown"')
    REQUEST_ID=$(echo "$CLASSIFY_BODY" | jq -r '.request_id // "missing"')
    REASONS=$(echo "$CLASSIFY_BODY" | jq -r '.reasons // []')
    
    echo "   Spam: $SPAM"
    echo "   Path: $PATH_FIELD"
    echo "   Request ID: $REQUEST_ID"
    echo "   Reasons: $REASONS"
    
    if [ "$SPAM" != "true" ]; then
        echo "⚠️  Warning: Expected spam=true, got spam=$SPAM"
    fi
    
    if [ "$PATH_FIELD" = "unknown" ] || [ -z "$PATH_FIELD" ]; then
        echo "⚠️  Warning: Missing path field"
    fi
    
    if [ "$REQUEST_ID" = "missing" ] || [ -z "$REQUEST_ID" ]; then
        echo "⚠️  Warning: Missing request_id"
    fi
else
    echo "❌ Classification request failed: HTTP $CLASSIFY_CODE"
    echo "$CLASSIFY_BODY"
    exit 1
fi

echo ""

# Test 3: Batch classification
echo "3️⃣  Testing /v1/batch (5 mixed items)..."
BATCH_PAYLOAD='[
  {"text": "Продам iPhone 12", "lang": "ru"},
  {"text": "Hello, how are you?", "lang": "en"},
  {"text": "bit.ly/xxx", "lang": "en"},
  {"text": "Normal conversation", "lang": "en"},
  {"text": "Работа на дому 1000$ в день", "lang": "ru"}
]'

BATCH_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$BASE_URL/v1/batch" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BATCH_PAYLOAD")

BATCH_BODY=$(echo "$BATCH_RESPONSE" | head -n -1)
BATCH_CODE=$(echo "$BATCH_RESPONSE" | tail -n 1)

if [ "$BATCH_CODE" = "200" ]; then
    echo "✅ Batch request successful (200)"
    
    BATCH_COUNT=$(echo "$BATCH_BODY" | jq 'length')
    echo "   Results count: $BATCH_COUNT"
    
    if [ "$BATCH_COUNT" != "5" ]; then
        echo "⚠️  Warning: Expected 5 results, got $BATCH_COUNT"
    fi
    
    # Check that all results have required fields
    for i in {0..4}; do
        SPAM_VAL=$(echo "$BATCH_BODY" | jq -r ".[$i].spam // .[$i].is_spam // null")
        PATH_VAL=$(echo "$BATCH_BODY" | jq -r ".[$i].path // null")
        REQ_ID=$(echo "$BATCH_BODY" | jq -r ".[$i].request_id // null")
        
        if [ "$SPAM_VAL" = "null" ]; then
            echo "⚠️  Warning: Result $i missing spam field"
        fi
        if [ "$PATH_VAL" = "null" ]; then
            echo "⚠️  Warning: Result $i missing path field"
        fi
        if [ "$REQ_ID" = "null" ]; then
            echo "⚠️  Warning: Result $i missing request_id"
        fi
    done
    
    echo "   Sample result:"
    echo "$BATCH_BODY" | jq '.[0]'
else
    echo "❌ Batch request failed: HTTP $BATCH_CODE"
    echo "$BATCH_BODY"
    exit 1
fi

echo ""
echo "✅ All smoke tests passed!"
echo ""
echo "Next steps:"
echo "1. Monitor metrics dashboard for 24 hours"
echo "2. Check error rates and latency"
echo "3. Review user feedback"
echo "4. Prepare D+3 report"

