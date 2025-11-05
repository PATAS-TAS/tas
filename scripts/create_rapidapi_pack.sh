#!/bin/bash
# Create RapidAPI pack ZIP with all assets
# Usage: ./create_rapidapi_pack.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="$REPO_ROOT/release"
PACK_DIR="$RELEASE_DIR/rapidapi-pack"
ZIP_FILE="$RELEASE_DIR/rapidapi-pack.zip"

echo "📦 Creating RapidAPI pack..."

# Create directories
mkdir -p "$PACK_DIR"
mkdir -p "$RELEASE_DIR"

# Copy OpenAPI spec
echo "📄 Copying OpenAPI spec..."
cp "$REPO_ROOT/openapi.yaml" "$PACK_DIR/"

# Copy Postman collection
echo "📬 Copying Postman collection..."
cp "$REPO_ROOT/postman_collection.json" "$PACK_DIR/"

# Copy RapidAPI card content
echo "📋 Copying RapidAPI card..."
cp "$REPO_ROOT/RAPIDAPI_CARD.md" "$PACK_DIR/"

# Copy screenshots
echo "📸 Copying screenshots..."
ASSETS_DIR="$REPO_ROOT/docs/assets"
if [ -d "$ASSETS_DIR" ]; then
    mkdir -p "$PACK_DIR/screenshots"
    for file in screen-demo.png screen-swagger.png screen-dashboard.png latency.gif; do
        if [ -f "$ASSETS_DIR/$file" ]; then
            cp "$ASSETS_DIR/$file" "$PACK_DIR/screenshots/"
            echo "   ✅ $file"
        else
            echo "   ⚠️  Missing: $file"
        fi
    done
else
    echo "   ⚠️  Assets directory not found: $ASSETS_DIR"
fi

# Create quickstart README
echo "📝 Creating quickstart README..."
cat > "$PACK_DIR/README.md" << 'EOF'
# TAS API Quick Start

## cURL Example

```bash
curl -X POST https://tas.fly.dev/v1/classify \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "text": "Earn $1000/day working from home! Click https://scam.com",
    "lang": "en"
  }'
```

## Python SDK

```bash
pip install tas-sdk
```

```python
from tas_sdk import TASClient

client = TASClient(api_key="your-api-key")
result = client.classify(
    "Selling iPhone 13 Pro Max, $500, call 555-1234",
    lang="en"
)

print(f"Spam: {result['spam']}")
print(f"Score: {result['score']}")
```

## Node.js SDK

```bash
npm install tas-sdk
```

```javascript
const { TASClient } = require('tas-sdk');

const client = new TASClient('your-api-key');
const result = await client.classify(
    'Work from home! Earn $1000/day!',
    'en'
);

console.log(result.spam);
console.log(result.score);
```

## Go SDK

```go
package main

import (
    "fmt"
    "github.com/your-org/tas-sdk-go"
)

func main() {
    client := tas.NewClient("your-api-key")
    result, err := client.Classify("Spam message", "en")
    if err != nil {
        panic(err)
    }
    fmt.Printf("Spam: %v\\n", result.Spam)
    fmt.Printf("Score: %f\\n", result.Score)
}
```

## API Endpoints

- `POST /v1/classify` - Classify single message
- `POST /v1/batch` - Classify up to 100 messages
- `GET /v1/health` - Health check
- `GET /v1/metrics` - Prometheus metrics

## Documentation

- Full API docs: https://kiku-jw.github.io/tas/
- OpenAPI spec: `openapi.yaml`
- Postman collection: `postman_collection.json`

## Support

- GitHub: https://github.com/kiku-jw/tas
- Status: https://kiku-jw.github.io/tas/status.html
EOF

echo "✅ Created: $PACK_DIR/README.md"

# Create ZIP
echo "📦 Creating ZIP archive..."
cd "$RELEASE_DIR"
zip -r "$ZIP_FILE" rapidapi-pack/ -q

echo ""
echo "✅ RapidAPI pack created!"
echo "📁 Location: $ZIP_FILE"
echo "📊 Size: $(du -h "$ZIP_FILE" | cut -f1)"
echo ""
echo "Contents:"
unzip -l "$ZIP_FILE" | tail -n +4 | head -n -2

