#!/bin/bash
# Export Grafana dashboard as PNG
# Requires: GRAFANA_URL and GRAFANA_API_KEY environment variables

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_API_KEY="${GRAFANA_API_KEY:-}"
DASHBOARD_UID="${DASHBOARD_UID:-tas-dashboard}"
OUTPUT_DIR="${OUTPUT_DIR:-docs/assets}"
OUTPUT_FILE="${OUTPUT_FILE:-grafana_dashboard.png}"

mkdir -p "$OUTPUT_DIR"

if [ -z "$GRAFANA_API_KEY" ]; then
    echo "⚠️  GRAFANA_API_KEY not set. Creating placeholder..."
    echo "   Set GRAFANA_API_KEY and GRAFANA_URL to export dashboard"
    touch "$OUTPUT_DIR/$OUTPUT_FILE"
    exit 0
fi

echo "📊 Exporting Grafana dashboard..."

# Get dashboard JSON
DASHBOARD_JSON=$(curl -s \
    -H "Authorization: Bearer $GRAFANA_API_KEY" \
    "$GRAFANA_URL/api/dashboards/uid/$DASHBOARD_UID")

if [ $? -ne 0 ]; then
    echo "❌ Failed to fetch dashboard"
    exit 1
fi

# Render dashboard as PNG (requires Grafana rendering API)
RENDER_URL="$GRAFANA_URL/render/d-solo/$DASHBOARD_UID"
TIMEOUT="300"
WIDTH="1920"
HEIGHT="1080"

curl -s \
    -H "Authorization: Bearer $GRAFANA_API_KEY" \
    "$RENDER_URL?from=now-24h&to=now&width=$WIDTH&height=$HEIGHT&timeout=$TIMEOUT" \
    -o "$OUTPUT_DIR/$OUTPUT_FILE"

if [ $? -eq 0 ] && [ -f "$OUTPUT_DIR/$OUTPUT_FILE" ]; then
    echo "✅ Dashboard exported: $OUTPUT_DIR/$OUTPUT_FILE"
else
    echo "⚠️  Export failed. Using Grafana UI:"
    echo "   1. Open dashboard in Grafana"
    echo "   2. Click Share → Export → Save as image"
    echo "   3. Save to $OUTPUT_DIR/$OUTPUT_FILE"
fi

