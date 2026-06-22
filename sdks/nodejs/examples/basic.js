/**
 * Basic example using TAS Node.js SDK
 */
const { TASClient } = require('../index');

async function main() {
    // Initialize client
    const client = new TASClient(
        'your-api-key-here',
        'https://tas.fly.dev'
    );

    // Example 1: Classify spam
    console.log('Example 1: Spam detection');
    let result = await client.classify(
        'Earn money from home! Click here https://spam.com',
        'en'
    );
    console.log(`  Is spam: ${result.is_spam}`);
    console.log(`  Confidence: ${result.confidence.toFixed(3)}`);
    console.log(`  Reason: ${result.reason}`);
    console.log();

    // Example 2: Legitimate message
    console.log('Example 2: Legitimate message');
    result = await client.classify(
        'Hello, how are you? Want to grab coffee?',
        'en'
    );
    console.log(`  Is spam: ${result.is_spam}`);
    console.log(`  Confidence: ${result.confidence.toFixed(3)}`);
    console.log(`  Reason: ${result.reason}`);
    console.log();

    // Example 3: Russian spam
    console.log('Example 3: Russian spam');
    result = await client.classify(
        'Продам iPhone 12, цена 25000 руб. Срочно!',
        'ru'
    );
    console.log(`  Is spam: ${result.is_spam}`);
    console.log(`  Confidence: ${result.confidence.toFixed(3)}`);
    console.log(`  Reason: ${result.reason}`);
    console.log();

    // Example 4: Health check
    console.log('Example 4: Health check');
    const health = await client.health();
    console.log(`  Status: ${health.status}`);
    console.log(`  Version: ${health.version}`);
    console.log(`  LLM enabled: ${health.llm_enabled}`);
    console.log();

    // Example 5: Version info
    console.log('Example 5: Version info');
    const version = await client.version();
    console.log(`  API Version: ${version.api_version}`);
    console.log(`  Version: ${version.version}`);
}

main().catch(console.error);

