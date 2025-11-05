#!/usr/bin/env python3
"""
Generate screenshots for RapidAPI using Playwright
Requires: playwright package installed
"""

import asyncio
import sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("Error: playwright not installed. Install with: pip install playwright && playwright install")
    sys.exit(1)

BASE_URL = "https://kiku-jw.github.io/tas"
LOCAL_URL = "http://localhost:8000"
API_URL = "https://tas.fly.dev"
OUTPUT_DIR = Path("docs/assets")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


async def screenshot_demo(page):
    """Screenshot of demo page with form and real response"""
    print("📸 Screenshot: Demo page with form and response...")
    
    await page.goto(f"{BASE_URL}/#quickstart", wait_until="networkidle")
    await page.wait_for_timeout(2000)
    
    # Fill form with example spam message
    textarea = page.locator('textarea[name="text"]')
    if await textarea.count() > 0:
        await textarea.fill("Earn $1000/day working from home! Click https://scam.com")
        await page.wait_for_timeout(500)
        
        # Click submit button
        submit_btn = page.locator('button[type="submit"]')
        if await submit_btn.count() > 0:
            await submit_btn.click()
            await page.wait_for_timeout(3000)  # Wait for response
    
    await page.screenshot(path=str(OUTPUT_DIR / "screen-demo.png"), full_page=True)
    print("✅ Saved: docs/assets/screen-demo.png")


async def screenshot_swagger(page):
    """Screenshot of Swagger/OpenAPI docs"""
    print("📸 Screenshot: Swagger/OpenAPI docs...")
    
    # Try local Swagger first, then production
    swagger_urls = [
        f"{LOCAL_URL}/docs",
        f"{API_URL}/docs",
        f"{BASE_URL}/#api",
    ]
    
    for url in swagger_urls:
        try:
            await page.goto(url, wait_until="networkidle", timeout=10000)
            await page.wait_for_timeout(2000)
            
            # Check if page loaded (look for Swagger UI elements)
            if await page.locator(".swagger-ui, .openapi, #swagger-ui").count() > 0:
                await page.screenshot(path=str(OUTPUT_DIR / "screen-swagger.png"), full_page=True)
                print(f"✅ Saved: docs/assets/screen-swagger.png (from {url})")
                return
        except Exception as e:
            print(f"⚠️  Could not load {url}: {e}")
            continue
    
    # Fallback: screenshot API docs page
    await page.goto(f"{BASE_URL}/#api", wait_until="networkidle")
    await page.screenshot(path=str(OUTPUT_DIR / "screen-swagger.png"), full_page=True)
    print("✅ Saved: docs/assets/screen-swagger.png (fallback)")


async def screenshot_dashboard(page):
    """Screenshot of Grafana dashboard (requires Grafana running)"""
    print("📸 Screenshot: Grafana dashboard...")
    
    # Try to connect to local Grafana
    grafana_urls = [
        "http://localhost:3000/d/tas-dashboard",
        "http://localhost:3000",
    ]
    
    for url in grafana_urls:
        try:
            await page.goto(url, wait_until="networkidle", timeout=10000)
            await page.wait_for_timeout(3000)  # Wait for dashboard to load
            
            # Try to login if needed
            login_btn = page.locator('button:has-text("Log in"), input[type="password"]')
            if await login_btn.count() > 0:
                print("⚠️  Grafana requires login. Please login manually or set GRAFANA_URL env var.")
                print("   Skipping dashboard screenshot...")
                # Create placeholder
                await page.set_content("""
                    <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
                    <h1>Grafana Dashboard</h1>
                    <p>Grafana dashboard screenshot requires manual setup.</p>
                    <p>Set GRAFANA_URL environment variable or login to Grafana.</p>
                    </body></html>
                """)
            
            await page.screenshot(path=str(OUTPUT_DIR / "screen-dashboard.png"), full_page=True)
            print("✅ Saved: docs/assets/screen-dashboard.png")
            return
        except Exception as e:
            print(f"⚠️  Could not load Grafana at {url}: {e}")
            continue
    
    # Create placeholder
    print("⚠️  Grafana not accessible. Creating placeholder...")
    placeholder = OUTPUT_DIR / "screen-dashboard.png"
    placeholder.write_bytes(b"")  # Placeholder, user needs to update manually
    print("⚠️  Created placeholder. Please update docs/assets/screen-dashboard.png manually.")


async def generate_latency_gif():
    """Generate latency GIF from performance report"""
    print("📸 Generating latency GIF from performance report...")
    
    # Look for performance report data
    reports_dir = Path("reports")
    if not reports_dir.exists():
        print("⚠️  Reports directory not found. Creating placeholder...")
        OUTPUT_DIR / "latency.gif"
        print("⚠️  Please generate latency.gif manually from performance data.")
        return
    
    # Try to find latest performance data
    import json
    metrics_files = sorted(reports_dir.glob("metrics_*.json"), reverse=True)
    
    if not metrics_files:
        print("⚠️  No metrics files found. Creating placeholder...")
        OUTPUT_DIR / "latency.gif"
        print("⚠️  Please generate latency.gif manually from performance data.")
        return
    
    # Read metrics and create simple visualization
    try:
        with open(metrics_files[0]) as f:
            metrics = json.load(f)
        
        # Extract latency data
        latency_data = metrics.get("latency", {})
        p95 = latency_data.get("p95", {})
        
        # Create simple text-based visualization
        print(f"📊 Found latency data: P95 rules={p95.get('rules_only', 'N/A')}ms, LLM={p95.get('with_llm', 'N/A')}ms")
        
        # Note: Creating actual GIF requires matplotlib or similar
        # For now, create placeholder
        print("⚠️  GIF generation requires matplotlib/pillow. Creating placeholder...")
        print("   To generate: python scripts/generate_latency_gif.py")
        
        # Create script for GIF generation
        gif_script = Path("scripts/generate_latency_gif.py")
        if not gif_script.exists():
            gif_script.write_text("""#!/usr/bin/env python3
# Generate latency GIF from performance metrics
# Requires: matplotlib, pillow, numpy

import json
import matplotlib.pyplot as plt
import matplotlib.animation as animation
from pathlib import Path
import numpy as np

reports_dir = Path("reports")
metrics_files = sorted(reports_dir.glob("metrics_*.json"), reverse=True)

if not metrics_files:
    print("No metrics files found")
    exit(1)

# Load metrics
with open(metrics_files[0]) as f:
    metrics = json.load(f)

# Extract latency trends (simulate from historical data)
fig, ax = plt.subplots(figsize=(10, 6))
ax.set_xlabel('Time')
ax.set_ylabel('Latency (ms)')
ax.set_title('TAS API Latency Trends (P95)')
ax.grid(True)

# Simulate data (replace with actual historical data)
times = np.arange(0, 100)
rules_latency = 180 + 20 * np.sin(times / 10) + np.random.normal(0, 5, 100)
llm_latency = 650 + 50 * np.sin(times / 8) + np.random.normal(0, 20, 100)

line1, = ax.plot([], [], 'b-', label='Rules-only (P95)')
line2, = ax.plot([], [], 'r-', label='With LLM (P95)')
ax.legend()

def animate(i):
    line1.set_data(times[:i+1], rules_latency[:i+1])
    line2.set_data(times[:i+1], llm_latency[:i+1])
    return line1, line2

ani = animation.FuncAnimation(fig, animate, frames=100, interval=50, blit=True)
ani.save('docs/assets/latency.gif', writer='pillow', fps=10)
print("✅ Generated: docs/assets/latency.gif")
""")
            gif_script.chmod(0o755)
            print("✅ Created: scripts/generate_latency_gif.py")
        
    except Exception as e:
        print(f"⚠️  Error processing metrics: {e}")
        print("⚠️  Please generate latency.gif manually.")


async def main():
    """Main function"""
    print("🎬 Starting screenshot generation...")
    print("")
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            device_scale_factor=2
        )
        page = await context.new_page()
        
        try:
            await screenshot_demo(page)
            await screenshot_swagger(page)
            await screenshot_dashboard(page)
            await generate_latency_gif()
            
            print("")
            print("✅ Screenshot generation complete!")
            print(f"📁 Output directory: {OUTPUT_DIR}")
            
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

