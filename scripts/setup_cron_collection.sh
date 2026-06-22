#!/bin/bash
# Setup cron job for automated data collection
# Runs daily at 2 AM UTC

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRON_LOG="$PROJECT_DIR/logs/data_collection.log"

# Create logs directory
mkdir -p "$PROJECT_DIR/logs"

# Create cron job entry
CRON_ENTRY="0 2 * * * cd $PROJECT_DIR && $PROJECT_DIR/scripts/run_data_collection.sh >> $CRON_LOG 2>&1"

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -q "run_data_collection.sh"; then
    echo "⚠️  Cron job already exists"
    echo "Current crontab:"
    crontab -l | grep "run_data_collection.sh"
else
    # Add cron job
    (crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -
    echo "✅ Cron job added:"
    echo "   $CRON_ENTRY"
    echo ""
    echo "📋 Current crontab:"
    crontab -l
fi

echo ""
echo "💡 To remove the cron job:"
echo "   crontab -e"
echo "   (remove the line with run_data_collection.sh)"

