# TAS Node.js SDK

Node.js client library for TAS (Transmodal Anti-Spam) API.

## Installation

```bash
npm install tas-sdk
```

Or from source:

```bash
cd sdks/nodejs
npm install
```

## Quick Start

```javascript
const { TASClient } = require('tas-sdk');

// Initialize client
const client = new TASClient(
    'your-api-key-here',
    'https://tas.fly.dev'  // or RapidAPI endpoint
);

// Classify text
(async () => {
    const result = await client.classify(
        'Earn money from home! Click here https://spam.com',
        'en'
    );
    
    console.log(`Is spam: ${result.is_spam}`);
    console.log(`Confidence: ${result.confidence}`);
    console.log(`Reason: ${result.reason}`);
})();
```

## Quick Function

For simple one-off classifications:

```javascript
const { classifyText } = require('tas-sdk');

(async () => {
    const result = await classifyText(
        'Продам iPhone 12, цена 25000 руб',
        'your-api-key',
        'ru'
    );
    
    console.log(result);
})();
```

## Examples

### Basic Usage

```javascript
const { TASClient } = require('tas-sdk');

const client = new TASClient('your-api-key');

(async () => {
    // Classify spam
    const spamResult = await client.classify('Buy cheap viagra now!');
    console.log(spamResult.is_spam); // true

    // Classify legitimate message
    const legitResult = await client.classify('Hello, how are you?');
    console.log(legitResult.is_spam); // false
})();
```

### With Sender/Message IDs

```javascript
const result = await client.classify(
    'Check out this amazing offer!',
    'en',
    'user123',  // senderId
    'msg456'    // messageId
);
```

### Health Check

```javascript
const health = await client.health();
console.log(`Status: ${health.status}`);
console.log(`Version: ${health.version}`);
```

### Error Handling

```javascript
try {
    const result = await client.classify('Test message');
} catch (error) {
    if (error.message.includes('429')) {
        console.log('Rate limit exceeded');
    } else if (error.message.includes('401')) {
        console.log('Invalid API key');
    } else {
        console.log(`Error: ${error.message}`);
    }
}
```

## API Reference

### TASClient

#### `constructor(apiKey, baseUrl = 'https://tas.fly.dev', apiVersion = 'v1')`

Initialize the client.

**Parameters:**
- `apiKey` (string): Your API key
- `baseUrl` (string): Base URL (default: https://tas.fly.dev)
- `apiVersion` (string): API version (default: "v1")

#### `classify(text, lang = 'en', senderId = null, messageId = null)`

Classify text as spam or not spam.

**Parameters:**
- `text` (string): Text to classify (1-8192 characters)
- `lang` (string): Language code (default: "en")
- `senderId` (string, optional): Sender identifier
- `messageId` (string, optional): Message identifier

**Returns:**
- `Promise<Object>`: `{is_spam: boolean, confidence: number, reason: string}`

#### `health()`

Get API health status.

**Returns:**
- `Promise<Object>`: Health status and metrics

#### `version()`

Get API version.

**Returns:**
- `Promise<Object>`: Version information

## RapidAPI Usage

When using RapidAPI, use the RapidAPI endpoint:

```javascript
const client = new TASClient(
    'your-rapidapi-key',
    'https://tas-api1.p.rapidapi.com'  // RapidAPI endpoint
);
```

## License

MIT License

