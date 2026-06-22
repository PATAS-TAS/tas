#!/bin/bash
# Check status of background scripts and their results

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "🔍 Background Scripts Status Report"
echo "===================================="
echo "Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo ""

# 1. Check cron jobs
echo "1️⃣  Cron Jobs Status:"
echo "-------------------"
CRON_JOBS=$(crontab -l 2>/dev/null | grep -E "(auto_improve|data_collection)" || echo "None")
if [ "$CRON_JOBS" != "None" ]; then
    echo "$CRON_JOBS" | while read line; do
        echo "  ✅ $line"
    done
else
    echo "  ⚠️  No cron jobs configured"
    echo "  💡 Run: ./scripts/setup_auto_improve.sh"
fi
echo ""

# 2. Check recent logs
echo "2️⃣  Recent Logs:"
echo "---------------"
if ls logs/*.log 1>/dev/null 2>&1; then
    LATEST_LOG=$(ls -t logs/*.log | head -1)
    echo "  Latest log: $LATEST_LOG"
    echo "  Last 5 lines:"
    tail -5 "$LATEST_LOG" | sed 's/^/    /'
else
    echo "  ⚠️  No log files found"
fi
echo ""

# 3. Check feedback database
echo "3️⃣  Feedback Database:"
echo "---------------------"
python3 -c "
from app.feedback_db import FeedbackDB
db = FeedbackDB()
summary = db.get_summary()
print(f'  Total feedback: {summary[\"total_feedback\"]}')
print(f'  False Positives: {summary[\"false_positives\"]}')
print(f'  False Negatives: {summary[\"false_negatives\"]}')
print(f'  Unique rules: {summary[\"unique_rules\"]}')
" 2>/dev/null || echo "  ⚠️  Unable to read database"
echo ""

# 4. Check generated reports
echo "4️⃣  Generated Reports:"
echo "---------------------"
if [ -f "reports/feedback_analysis/latest.json" ]; then
    echo "  ✅ Latest analysis report exists"
    SIZE=$(stat -f%z "reports/feedback_analysis/latest.json" 2>/dev/null || stat -c%s "reports/feedback_analysis/latest.json" 2>/dev/null || echo "0")
    if [ "$SIZE" -gt 100 ]; then
        echo "    Contains data ($SIZE bytes)"
    else
        echo "    Empty or minimal"
    fi
else
    echo "  ⚠️  No analysis report"
fi

if [ -f "rules/suggestions/latest.json" ]; then
    echo "  ✅ Latest improvement suggestions exist"
    SIZE=$(stat -f%z "rules/suggestions/latest.json" 2>/dev/null || stat -c%s "rules/suggestions/latest.json" 2>/dev/null || echo "0")
    if [ "$SIZE" -gt 100 ]; then
        echo "    Contains data ($SIZE bytes)"
    else
        echo "    Empty or minimal"
    fi
else
    echo "  ⚠️  No improvement suggestions"
fi

if [ -f "data/training_dataset.json" ]; then
    echo "  ✅ Training dataset exists"
    SIZE=$(stat -f%z "data/training_dataset.json" 2>/dev/null || stat -c%s "data/training_dataset.json" 2>/dev/null || echo "0")
    echo "    Size: $SIZE bytes"
else
    echo "  ⚠️  No training dataset"
fi
echo ""

# 5. Check auto-improvement cycles
echo "5️⃣  Auto-Improvement Cycles:"
echo "---------------------------"
if ls reports/auto_improvement/cycle_*.json 1>/dev/null 2>&1; then
    LATEST_CYCLE=$(ls -t reports/auto_improvement/cycle_*.json | head -1)
    echo "  Latest cycle: $(basename $LATEST_CYCLE)"
    python3 -c "
import json
with open('$LATEST_CYCLE') as f:
    data = json.load(f)
    print(f'    Status: {data.get(\"status\", \"unknown\")}')
    print(f'    Applied: {len(data.get(\"applied\", []))} improvements')
    print(f'    Failed: {len(data.get(\"failed\", []))} improvements')
    " 2>/dev/null || echo "    Unable to parse"
else
    echo "  ⚠️  No improvement cycles run yet"
fi
echo ""

# 6. Check quality tests
echo "6️⃣  Quality Tests:"
echo "-----------------"
if ls reports/quality_tests/quality_test_*.json 1>/dev/null 2>&1; then
    LATEST_TEST=$(ls -t reports/quality_tests/quality_test_*.json | head -1)
    echo "  Latest test: $(basename $LATEST_TEST)"
    python3 -c "
import json
with open('$LATEST_TEST') as f:
    data = json.load(f)
    print(f'    Status: {data.get(\"status\", \"unknown\")}')
    if 'metrics' in data:
        m = data['metrics']
        print(f'    FPR: {m.get(\"fpr\", 0):.2%}')
        print(f'    Recall: {m.get(\"recall\", 0):.2%}')
        print(f'    Precision: {m.get(\"precision\", 0):.2%}')
    " 2>/dev/null || echo "    Unable to parse"
else
    echo "  ⚠️  No quality tests run yet"
fi
echo ""

# 7. Summary
echo "📊 Summary:"
echo "----------"
TOTAL_FEEDBACK=$(python3 -c "from app.feedback_db import FeedbackDB; db = FeedbackDB(); print(db.get_summary()['total_feedback'])" 2>/dev/null || echo "0")
CYCLES=$(ls reports/auto_improvement/cycle_*.json 2>/dev/null | wc -l | tr -d ' ')
TESTS=$(ls reports/quality_tests/quality_test_*.json 2>/dev/null | wc -l | tr -d ' ')

echo "  Feedback entries: $TOTAL_FEEDBACK"
echo "  Improvement cycles: $CYCLES"
echo "  Quality tests: $TESTS"

if [ "$TOTAL_FEEDBACK" -lt 20 ]; then
    echo ""
    echo "💡 System needs 20+ feedback entries to start auto-improving"
    echo "   Current: $TOTAL_FEEDBACK entries"
fi

echo ""
echo "✅ Status check complete!"

