# Data Collection & Improvement System

**Status**: ✅ **ACTIVATED**

## Overview

Automated system for collecting production data, analyzing feedback, and generating rule improvement suggestions.

## Components

### 1. Feedback Collection (`scripts/collect_feedback.py`)

**Modes:**
- **shadow**: Collect data without affecting production (A/B testing)
- **sampling**: Sample percentage of API requests for review
- **export**: Export training dataset from feedback database

**Usage:**
```bash
# Export training dataset
python scripts/collect_feedback.py --mode export

# Collect shadow data
python scripts/collect_feedback.py --mode shadow --input data/samples.json

# Sample from API logs
python scripts/collect_feedback.py --mode sampling --log-file logs/api.log --sample-rate 0.1
```

### 2. Feedback Analysis (`scripts/analyze_feedback.py`)

Analyzes feedback data and identifies problematic rules.

**Features:**
- Rule performance analysis (FPR, FNR, Precision, Recall)
- Pattern analysis (common FP/FN patterns)
- Recommendations generation

**Usage:**
```bash
python scripts/analyze_feedback.py --output reports/feedback_analysis/latest.json
```

**Output:**
- JSON report with detailed analysis
- Markdown summary with recommendations

### 3. Rule Improvement (`scripts/improve_rules.py`)

Generates specific suggestions for rule modifications.

**Features:**
- FP/FN example analysis
- Pattern extraction from examples
- Suggested regex modifications
- Weight adjustment recommendations

**Usage:**
```bash
# Analyze all problematic rules
python scripts/improve_rules.py

# Analyze specific rule
python scripts/improve_rules.py --rule "promo"
```

**Output:**
- JSON with detailed suggestions
- Markdown report with actionable improvements

### 4. Automated Collection (`scripts/run_data_collection.sh`)

Daily script that runs all collection and analysis steps.

**Runs:**
1. Export training dataset
2. Analyze feedback
3. Generate improvement suggestions

**Usage:**
```bash
./scripts/run_data_collection.sh
```

### 5. Cron Setup (`scripts/setup_cron_collection.sh`)

Sets up daily automated collection at 2 AM UTC.

**Usage:**
```bash
./scripts/setup_cron_collection.sh
```

## Data Flow

```
Production API
    ↓
Feedback Endpoint (/v1/feedback)
    ↓
Feedback Database (feedback.db)
    ↓
Daily Collection Script
    ↓
Training Dataset + Analysis Reports
    ↓
Rule Improvement Suggestions
    ↓
Manual Review & Application
```

## Generated Files

### Data
- `data/training_dataset.json` - Training dataset export
- `data/collected/shadow_data.json` - Shadow mode collections

### Reports
- `reports/feedback_analysis/latest.json` - Latest analysis
- `reports/feedback_analysis/latest.md` - Markdown summary
- `rules/suggestions/latest.json` - Latest improvements
- `rules/suggestions/latest.md` - Markdown suggestions

### Logs
- `logs/data_collection.log` - Cron job logs

## Activation Steps

1. **Initial Setup** (Done):
   ```bash
   chmod +x scripts/*.py scripts/*.sh
   ```

2. **Test Collection**:
   ```bash
   python scripts/collect_feedback.py --mode export
   ```

3. **Test Analysis**:
   ```bash
   python scripts/analyze_feedback.py
   ```

4. **Setup Cron** (Optional):
   ```bash
   ./scripts/setup_cron_collection.sh
   ```

## Next Steps

1. **Collect Initial Data**:
   - Submit feedback via `/v1/feedback` endpoint
   - Or use shadow mode to collect production data

2. **Review Analysis**:
   - Check `reports/feedback_analysis/latest.md`
   - Identify top problematic rules

3. **Apply Improvements**:
   - Review `rules/suggestions/latest.md`
   - Manually apply suggested rule modifications
   - Test changes in canary mode

4. **Monitor Results**:
   - Track FPR/FNR after improvements
   - Collect new feedback
   - Iterate

## Requirements

- Minimum feedback for analysis: 5 entries (configurable)
- Minimum feedback per rule: 10 entries (for training dataset)
- Feedback database: `feedback.db` (SQLite)

## Status

✅ **All scripts created and ready**
✅ **Initial test run completed**
⏳ **Waiting for production feedback data**

---
**Last Updated**: 2025-11-05

