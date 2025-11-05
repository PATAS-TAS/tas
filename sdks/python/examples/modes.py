"""
TAS SDK - LLM Modes Examples
Demonstrates Managed, BYO, and Rules-only modes.
"""
from tas_sdk import TASClient

# Initialize client
api_key = "YOUR_API_KEY"
client = TASClient(api_key=api_key)

# Example 1: Managed Mode (Default)
# No configuration needed - uses TAS-managed LLM credentials
print("=== Managed Mode (Default) ===")
result = client.classify("Скидки -70% сегодня, пишите в тг @sale_best!", lang="ru")
print(f"Spam: {result['spam']}, Score: {result['score']}, Path: {result['path']}, Mode: {result.get('mode', 'managed')}")
print()

# Example 2: BYO Mode (Bring Your Own)
# Use your own LLM provider credentials
print("=== BYO Mode ===")
# Note: SDK needs to support custom headers
# For now, you can use requests directly:
import requests

response = requests.post(
    "https://tas.fly.dev/v1/classify",
    headers={
        "x-api-key": api_key,
        "X-LLM-Mode": "byo",
        "X-LLM-Provider": "openai",
        "X-LLM-Key": "sk-your-openai-key",
        "Content-Type": "application/json"
    },
    json={"text": "Скидки -70% сегодня!", "lang": "ru"}
)
result_byo = response.json()
print(f"Spam: {result_byo['spam']}, Score: {result_byo['score']}, Path: {result_byo['path']}, Mode: {result_byo.get('mode', 'byo')}")
print()

# Example 3: Rules-Only Mode
# Fastest mode, no LLM costs, P95 ~200ms
print("=== Rules-Only Mode ===")
response = requests.post(
    "https://tas.fly.dev/v1/classify",
    headers={
        "x-api-key": api_key,
        "X-LLM-Mode": "rules_only",
        "Content-Type": "application/json"
    },
    json={"text": "Скидки -70% сегодня!", "lang": "ru"}
)
result_rules = response.json()
print(f"Spam: {result_rules['spam']}, Score: {result_rules['score']}, Path: {result_rules['path']}, Mode: {result_rules.get('mode', 'rules_only')}")
print()

# Example 4: Batch Classification (Rules-Only)
print("=== Batch Classification (Rules-Only) ===")
texts = [
    "Продам iPhone 12",
    "Hello, how are you?",
    "bit.ly/xxx",
    "Normal conversation",
    "Работа на дому 1000$ в день"
]

response = requests.post(
    "https://tas.fly.dev/v1/batch",
    headers={
        "x-api-key": api_key,
        "X-LLM-Mode": "rules_only",
        "Content-Type": "application/json"
    },
    json=[{"text": t, "lang": "en"} for t in texts]
)
batch_results = response.json()
print(f"Processed {len(batch_results)} messages")
for i, r in enumerate(batch_results):
    print(f"  {i+1}. Spam: {r['spam']}, Score: {r['score']:.2f}, Path: {r['path']}")

