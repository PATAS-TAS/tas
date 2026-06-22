#!/usr/bin/env python3
"""TAS API Python client example"""

import requests
import os

API_KEY = os.getenv("TAS_API_KEY", "your-api-key")
BASE_URL = os.getenv("TAS_BASE_URL", "https://tas.fly.dev")

def classify(text: str, lang: str = "en"):
    """Classify text as spam or not"""
    response = requests.post(
        f"{BASE_URL}/v1/classify",
        headers={
            "Content-Type": "application/json",
            "X-API-Key": API_KEY
        },
        json={"text": text, "lang": lang}
    )
    response.raise_for_status()
    return response.json()

if __name__ == "__main__":
    result = classify("Earn $1000/day working from home! Click https://scam.com")
    print(f"Spam: {result['spam']}")
    print(f"Score: {result['score']}")
    print(f"Reasons: {result['reasons']}")

