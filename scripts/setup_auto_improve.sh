#!/bin/bash
# Setup automatic improvement system
# - Daily data collection and analysis
# - Weekly auto-improvement cycle
# - Quality testing after improvements

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRON_LOG="$PROJECT_DIR/logs/auto_improve.log"

mkdir -p "$PROJECT_DIR/logs"

echo "🔧 Setting up automatic improvement system..."
echo ""

# Check existing cron jobs
EXISTING=$(crontab -l 2>/dev/null | grep -c "auto_improve" || echo "0")

if [ "$EXISTING" -gt 0 ]; then
    echo "⚠️  Auto-improvement cron jobs already exist:"
    crontab -l | grep "auto_improve"
    echo ""
    read -p "Replace existing jobs? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cancelled"
        exit 0
    fi
    # Remove existing jobs
    crontab -l 2>/dev/null | grep -v "auto_improve" | crontab -
fi

# Daily data collection (2 AM UTC)
DAILY_COLLECTION="0 2 * * * cd $PROJECT_DIR && $PROJECT_DIR/scripts/run_data_collection.sh >> $CRON_LOG 2>&1"

# Weekly auto-improvement (Sunday 3 AM UTC)
WEEKLY_IMPROVE="0 3 * * 0 cd $PROJECT_DIR && $PROJECT_DIR/scripts/auto_improve_cycle.sh >> $CRON_LOG 2>&1"

# Daily health monitoring (6 AM UTC)
DAILY_HEALTH="0 6 * * * cd $PROJECT_DIR && python3 $PROJECT_DIR/scripts/monitor_health.py >> $CRON_LOG 2>&1"

# Add cron jobs
(crontab -l 2>/dev/null; echo "$DAILY_COLLECTION"; echo "$WEEKLY_IMPROVE"; echo "$DAILY_HEALTH") | crontab -

echo "✅ Cron jobs added:"
echo ""
echo "Daily data collection (2 AM UTC):"
echo "   $DAILY_COLLECTION"
echo ""
echo "Weekly auto-improvement (Sunday 3 AM UTC):"
echo "   $WEEKLY_IMPROVE"
echo ""
echo "Daily health monitoring (6 AM UTC):"
echo "   $DAILY_HEALTH"
echo ""
echo "📋 Current crontab:"
crontab -l
echo ""
echo "💡 To view logs:"
echo "   tail -f $CRON_LOG"
echo ""
echo "💡 To remove cron jobs:"
echo "   crontab -e"
echo "   (remove lines with auto_improve)"

