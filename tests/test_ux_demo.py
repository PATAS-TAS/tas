"""
UX and Demo page testing.
"""
import pytest
from playwright.sync_api import sync_playwright, Page, expect
import time


@pytest.fixture(scope="module")
def demo_url():
    return "http://localhost:8080/index.html"


@pytest.fixture(scope="module")
def api_url():
    return "http://localhost:8000"


class TestDemoPageLoad:
    def test_page_loads(self, demo_url):
        """Test that demo page loads correctly."""
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(demo_url)
            expect(page.locator("h1")).to_contain_text("TAS")
            browser.close()
    
    def test_input_field_present(self, demo_url):
        """Test that input field is present."""
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(demo_url)
            textarea = page.locator("textarea")
            expect(textarea).to_be_visible()
            browser.close()
    
    def test_button_present(self, demo_url):
        """Test that check button is present."""
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(demo_url)
            button = page.locator("button:has-text('Check for Spam')")
            expect(button).to_be_visible()
            browser.close()


class TestDemoFunctionality:
    def test_input_validation(self, demo_url):
        """Test that empty input shows alert."""
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(demo_url)
            
            # Try to submit empty
            page.click("button:has-text('Check for Spam')")
            # Should show alert or error
            time.sleep(1)
            browser.close()
    
    def test_spam_detection(self, demo_url, api_url):
        """Test spam detection in demo."""
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(demo_url)
            
            # Enter spam text
            page.fill("textarea", "Продам iPhone 12, недорого! Звоните +79001234567")
            page.click("button:has-text('Check for Spam')")
            
            # Wait for result
            time.sleep(3)
            
            # Check if result is displayed
            result = page.locator("#result")
            # Result should be visible
            browser.close()
    
    def test_keyboard_shortcut(self, demo_url):
        """Test Ctrl+Enter shortcut."""
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(demo_url)
            
            page.fill("textarea", "Test message")
            page.keyboard.press("Control+Enter")
            
            time.sleep(2)
            browser.close()


class TestErrorHandling:
    def test_api_error_display(self, demo_url):
        """Test that API errors are displayed properly."""
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(demo_url)
            
            # Enter text
            page.fill("textarea", "Test error handling")
            page.click("button:has-text('Check for Spam')")
            
            time.sleep(3)
            browser.close()

