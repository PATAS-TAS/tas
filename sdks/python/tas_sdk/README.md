# TAS Python SDK

Python client library for TAS (Transmodal Anti-Spam) API.

## Installation

```bash
pip install tas-sdk
```

Or from source:

```bash
cd sdks/python
pip install -e .
```

## Quick Start

```python
from tas_sdk import TASClient

# Initialize client
client = TASClient(
    api_key="your-api-key-here",
    base_url="https://tas.fly.dev"  # or RapidAPI endpoint
)

# Classify text
result = client.classify(
    text="Earn money from home! Click here https://spam.com",
    lang="en"
)

print(f"Is spam: {result['is_spam']}")
print(f"Confidence: {result['confidence']}")
print(f"Reason: {result['reason']}")
```

## Quick Function

For simple one-off classifications:

```python
from tas_sdk import classify_text

result = classify_text(
    text="Продам iPhone 12, цена 25000 руб",
    api_key="your-api-key",
    lang="ru"
)

print(result)
```

## Examples

### Basic Usage

```python
from tas_sdk import TASClient

client = TASClient(api_key="your-api-key")

# Classify spam
result = client.classify("Buy cheap viagra now!")
assert result["is_spam"] == True

# Classify legitimate message
result = client.classify("Hello, how are you?")
assert result["is_spam"] == False
```

### With Sender/Message IDs

```python
client = TASClient(api_key="your-api-key")

result = client.classify(
    text="Check out this amazing offer!",
    sender_id="user123",
    message_id="msg456",
    lang="en"
)
```

### Health Check

```python
health = client.health()
print(f"Status: {health['status']}")
print(f"Version: {health['version']}")
```

### Error Handling

```python
import requests
from tas_sdk import TASClient

client = TASClient(api_key="your-api-key")

try:
    result = client.classify("Test message")
except requests.HTTPError as e:
    if e.response.status_code == 429:
        print("Rate limit exceeded")
    elif e.response.status_code == 401:
        print("Invalid API key")
    else:
        print(f"API error: {e}")
```

## API Reference

### TASClient

#### `__init__(api_key, base_url="https://tas.fly.dev", api_version="v1")`

Initialize the client.

**Parameters:**
- `api_key` (str): Your API key
- `base_url` (str): Base URL (default: https://tas.fly.dev)
- `api_version` (str): API version (default: "v1")

#### `classify(text, lang="en", sender_id=None, message_id=None)`

Classify text as spam or not spam.

**Parameters:**
- `text` (str): Text to classify (1-8192 characters)
- `lang` (str): Language code (default: "en")
- `sender_id` (str, optional): Sender identifier
- `message_id` (str, optional): Message identifier

**Returns:**
- `dict`: `{"is_spam": bool, "confidence": float, "reason": str}`

#### `health()`

Get API health status.

**Returns:**
- `dict`: Health status and metrics

#### `version()`

Get API version.

**Returns:**
- `dict`: Version information

## RapidAPI Usage

When using RapidAPI, use the RapidAPI endpoint:

```python
client = TASClient(
    api_key="your-rapidapi-key",
    base_url="https://tas-api1.p.rapidapi.com"  # RapidAPI endpoint
)
```

## License

MIT License

