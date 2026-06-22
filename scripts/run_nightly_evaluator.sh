#!/bin/bash
# Nightly evaluator runner script
# Add to crontab: 0 2 * * * /path/to/scripts/run_nightly_evaluator.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

# Activate poetry environment
export PATH="$HOME/.local/bin:$PATH"

# Run nightly evaluator
poetry run python nightly_evaluator.py \
    --sample 1000 \
    --threshold 0.35 \
    --file ../report.csv \
    2>&1 | tee -a reports/nightly_evaluator.log

echo "Nightly evaluation completed at $(date)"

