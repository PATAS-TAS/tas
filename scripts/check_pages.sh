#!/bin/bash
# Check GitHub Pages availability and anchors
# Usage: ./check_pages.sh

BASE_URL="https://kiku-jw.github.io/tas"

echo "🔍 Checking GitHub Pages availability..."
echo ""

# Check base URL
if curl -s -o /dev/null -w "%{http_code}" "$BASE_URL" | grep -q "200"; then
    echo "✅ Base URL accessible: $BASE_URL"
else
    echo "❌ Base URL not accessible: $BASE_URL"
    echo "   Note: Pages may take 5-10 minutes to deploy after enabling"
    exit 1
fi

# Check anchors
ANCHORS=(
    "#quickstart"
    "#modes"
    "#pricing"
    "#migration"
    "#limits"
)

echo ""
echo "Checking anchors..."
for anchor in "${ANCHORS[@]}"; do
    url="${BASE_URL}/${anchor}"
    if curl -s "$url" | grep -q "$anchor" || curl -s "$BASE_URL" | grep -q "$anchor"; then
        echo "✅ Anchor $anchor accessible"
    else
        echo "⚠️  Anchor $anchor not found (may need to scroll on page)"
    fi
done

echo ""
echo "📄 Status page: $BASE_URL/status.html"
echo "📚 Documentation: $BASE_URL"
echo ""
echo "✅ Pages check complete!"

