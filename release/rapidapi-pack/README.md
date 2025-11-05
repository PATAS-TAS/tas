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
