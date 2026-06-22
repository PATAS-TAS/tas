"""
Basic example using TAS Python SDK
"""
from tas_sdk import TASClient

# Initialize client
client = TASClient(
    api_key="your-api-key-here",
    base_url="https://tas.fly.dev"
)

# Example 1: Classify spam
print("Example 1: Spam detection")
result = client.classify(
    text="Earn money from home! Click here https://spam.com",
    lang="en"
)
print(f"  Is spam: {result['is_spam']}")
print(f"  Confidence: {result['confidence']:.3f}")
print(f"  Reason: {result['reason']}")
print()

# Example 2: Legitimate message
print("Example 2: Legitimate message")
result = client.classify(
    text="Hello, how are you? Want to grab coffee?",
    lang="en"
)
print(f"  Is spam: {result['is_spam']}")
print(f"  Confidence: {result['confidence']:.3f}")
print(f"  Reason: {result['reason']}")
print()

# Example 3: Russian spam
print("Example 3: Russian spam")
result = client.classify(
    text="Продам iPhone 12, цена 25000 руб. Срочно!",
    lang="ru"
)
print(f"  Is spam: {result['is_spam']}")
print(f"  Confidence: {result['confidence']:.3f}")
print(f"  Reason: {result['reason']}")
print()

# Example 4: Health check
print("Example 4: Health check")
health = client.health()
print(f"  Status: {health['status']}")
print(f"  Version: {health['version']}")
print(f"  LLM enabled: {health['llm_enabled']}")
print()

# Example 5: Version info
print("Example 5: Version info")
version = client.version()
print(f"  API Version: {version['api_version']}")
print(f"  Version: {version['version']}")

