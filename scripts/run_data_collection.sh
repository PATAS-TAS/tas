#!/bin/bash
# Automated data collection script
# Runs daily to collect feedback and generate improvement reports

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "🔄 Starting automated data collection..."
echo "Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo ""

# Create data directories
mkdir -p data/collected
mkdir -p reports/feedback_analysis
mkdir -p rules/suggestions

# 1. Export training dataset from feedback database
echo "1️⃣  Exporting training dataset..."
python3 scripts/collect_feedback.py --mode export --output data/training_dataset.json 2>/dev/null || {
    echo "⚠️  No feedback data available yet"
}

# 2. Analyze feedback and generate recommendations
echo ""
echo "2️⃣  Analyzing feedback data..."
python3 scripts/analyze_feedback.py --output reports/feedback_analysis/latest.json 2>/dev/null || {
    echo "⚠️  Insufficient feedback data for analysis"
}

# 3. Generate rule improvement suggestions
echo ""
echo "3️⃣  Generating rule improvement suggestions..."
python3 scripts/improve_rules.py --output rules/suggestions/latest.json 2>/dev/null || {
    echo "⚠️  No problematic rules to improve"
}

# 4. Summary
echo ""
echo "✅ Data collection complete!"
echo ""
echo "Generated files:"
ls -lh data/training_dataset.json 2>/dev/null || echo "  (training dataset not available)"
ls -lh reports/feedback_analysis/latest.json 2>/dev/null || echo "  (analysis report not available)"
ls -lh rules/suggestions/latest.json 2>/dev/null || echo "  (improvement suggestions not available)"
echo ""

# Check feedback database status
if [ -f feedback.db ]; then
    echo "📊 Feedback database status:"
    python3 -c "
import sys
sys.path.insert(0, '.')
from app.feedback_db import FeedbackDB
db = FeedbackDB()
summary = db.get_summary()
print(f'  Total feedback: {summary[\"total_feedback\"]}')
print(f'  False Positives: {summary[\"false_positives\"]}')
print(f'  False Negatives: {summary[\"false_negatives\"]}')
print(f'  Unique rules: {summary[\"unique_rules\"]}')
" 2>/dev/null || echo "  (unable to read database)"
fi

echo ""
echo "💡 Next steps:"
echo "  - Review improvement suggestions: cat rules/suggestions/latest.md"
echo "  - Review analysis report: cat reports/feedback_analysis/latest.md"
echo "  - Apply rule improvements manually after review"

