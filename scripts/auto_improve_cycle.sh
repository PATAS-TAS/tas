#!/bin/bash
# Complete auto-improvement cycle:
# 1. Collect feedback data
# 2. Analyze feedback
# 3. Auto-apply safe improvements
# 4. Test quality
# 5. Report results

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

LOG_FILE="logs/auto_improve_$(date -u +%Y%m%d_%H%M%S).log"
mkdir -p logs

echo "🔄 Starting auto-improvement cycle..."
echo "Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "Log: $LOG_FILE"
echo ""

# Step 1: Collect feedback data
echo "1️⃣  Collecting feedback data..."
python3 scripts/collect_feedback.py --mode export --output data/training_dataset.json >> "$LOG_FILE" 2>&1 || {
    echo "⚠️  No feedback data available"
}

# Step 2: Analyze feedback
echo ""
echo "2️⃣  Analyzing feedback..."
python3 scripts/analyze_feedback.py --output reports/feedback_analysis/latest.json >> "$LOG_FILE" 2>&1 || {
    echo "⚠️  Insufficient feedback for analysis"
    exit 0
}

# Step 3: Generate improvements
echo ""
echo "3️⃣  Generating improvements..."
python3 scripts/improve_rules.py --output rules/suggestions/latest.json >> "$LOG_FILE" 2>&1 || {
    echo "⚠️  No improvements generated"
}

# Step 4: Auto-apply safe improvements (dry-run first)
echo ""
echo "4️⃣  Testing auto-improvements (dry-run)..."
python3 scripts/auto_improve.py --dry-run >> "$LOG_FILE" 2>&1

# Check if there are improvements to apply
DRY_RUN_OUTPUT=$(python3 scripts/auto_improve.py --dry-run 2>&1)
if echo "$DRY_RUN_OUTPUT" | grep -q "Applied: [1-9]"; then
    echo ""
    echo "5️⃣  Applying safe improvements..."
    python3 scripts/auto_improve.py >> "$LOG_FILE" 2>&1 || {
        echo "❌ Failed to apply improvements"
        exit 1
    }
    
    # Step 6: Test quality after improvements
    echo ""
    echo "6️⃣  Testing quality after improvements..."
    python3 scripts/auto_test_quality.py >> "$LOG_FILE" 2>&1 || {
        echo "⚠️  Quality test failed or insufficient data"
    }
else
    echo "   No safe improvements to apply automatically"
fi

# Step 7: Summary
echo ""
echo "✅ Auto-improvement cycle complete!"
echo ""
echo "📊 Summary:"
echo "  - Log file: $LOG_FILE"
echo "  - Analysis: reports/feedback_analysis/latest.json"
echo "  - Improvements: rules/suggestions/latest.json"
echo "  - Quality tests: reports/quality_tests/"
echo ""
echo "💡 Review improvements:"
echo "   cat rules/suggestions/latest.md"

