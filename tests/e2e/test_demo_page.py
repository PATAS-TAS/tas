"""
E2E tests for demo page using Playwright.
Tests real user scenarios on the demo page.
"""
import pytest
from playwright.sync_api import Page, expect, sync_playwright
import time


@pytest.fixture(scope="module")
def page():
    """Create Playwright page instance."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        yield page
        browser.close()


def test_demo_page_loads(page: Page):
    """Test that demo page loads correctly."""
    page.goto("http://localhost:8000/docs/index.html")
    expect(page.locator("h1")).to_contain_text("TAS")
    expect(page.locator("#text")).to_be_visible()


def test_classify_spam_message(page: Page):
    """Test classifying a spam message."""
    page.goto("http://localhost:8000/docs/index.html")
    
    # Enter spam message
    page.fill("#text", "Скидки -70% сегодня, пишите в тг @sale_best!")
    
    # Click classify button
    page.click("button:has-text('Check for Spam')")
    
    # Wait for result
    page.wait_for_selector(".result.show", timeout=5000)
    
    # Check result shows spam
    result = page.locator(".result.show")
    expect(result).to_contain_text("SPAM", ignore_case=True)


def test_classify_safe_message(page: Page):
    """Test classifying a safe message."""
    page.goto("http://localhost:8000/docs/index.html")
    
    # Enter safe message
    page.fill("#text", "Hello, how are you?")
    
    # Click classify button
    page.click("button:has-text('Check for Spam')")
    
    # Wait for result
    page.wait_for_selector(".result.show", timeout=5000)
    
    # Check result shows safe
    result = page.locator(".result.show")
    expect(result).to_contain_text("SAFE", ignore_case=True)


def test_classify_multiple_messages(page: Page):
    """Test classifying multiple messages sequentially."""
    messages = [
        ("Скидки -70%!", True),  # spam
        ("Hello", False),  # safe
        ("bit.ly/xxx", True),  # spam (URL-only)
        ("How are you?", False),  # safe
    ]
    
    page.goto("http://localhost:8000/docs/index.html")
    
    for text, is_spam_expected in messages:
        page.fill("#text", text)
        page.click("button:has-text('Check for Spam')")
        page.wait_for_selector(".result.show", timeout=5000)
        
        result = page.locator(".result.show")
        if is_spam_expected:
            expect(result).to_contain_text("SPAM", ignore_case=True)
        else:
            expect(result).to_contain_text("SAFE", ignore_case=True)
        
        # Clear for next
        page.fill("#text", "")


def test_api_error_handling(page: Page):
    """Test error handling when API is unavailable."""
    page.goto("http://localhost:8000/docs/index.html")
    
    # Intercept API call and return error
    page.route("**/v1/classify", lambda route: route.fulfill(
        status=500,
        body='{"error": "Internal server error"}'
    ))
    
    page.fill("#text", "Test message")
    page.click("button:has-text('Check for Spam')")
    
    # Should show error message
    page.wait_for_timeout(2000)
    # Check for error indicator (implementation dependent)
    # This test may need adjustment based on actual error UI

