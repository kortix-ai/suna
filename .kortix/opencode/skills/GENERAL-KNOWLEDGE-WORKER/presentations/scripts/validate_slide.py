"""Validate a presentation slide's dimensions via Playwright.

Usage: uv run validate_slide.py <slide_html_path>

Renders the HTML at 1920x1080 and measures actual content height.
Outputs JSON with pass/fail and measurements.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright


def find_chromium() -> str | None:
    """Auto-detect Chromium executable path for the current platform."""
    # 1. Explicit env var override
    env_path = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path
    # 2. System chromium (Linux sandbox / Alpine)
    for p in ("/usr/bin/chromium-browser", "/usr/bin/chromium"):
        if os.path.isfile(p):
            return p
    # 3. Let Playwright use its own bundled chromium (macOS after `playwright install`)
    return None


async def validate(slide_path: str) -> dict:
    """Render slide and measure dimensions."""
    html_path = Path(slide_path).resolve()
    if not html_path.exists():
        return {"success": False, "error": f"File not found: {html_path}"}

    launch_opts: dict = {
        "headless": True,
        "args": ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    }
    chromium = find_chromium()
    if chromium:
        launch_opts["executable_path"] = chromium

    async with async_playwright() as p:
        browser = await p.chromium.launch(**launch_opts)
        try:
            page = await browser.new_page(viewport={"width": 1920, "height": 1080})
            await page.goto(f"file://{html_path}", wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(2000)

            dims = await page.evaluate("""
                () => {
                    const b = document.body;
                    const h = document.documentElement;
                    const scrollHeight = Math.max(b.scrollHeight, b.offsetHeight, h.clientHeight, h.scrollHeight, h.offsetHeight);
                    const scrollWidth = Math.max(b.scrollWidth, b.offsetWidth, h.clientWidth, h.scrollWidth, h.offsetWidth);
                    return { scrollHeight, scrollWidth, viewportHeight: window.innerHeight, viewportWidth: window.innerWidth };
                }
            """)
        finally:
            await browser.close()

    passed = dims["scrollHeight"] <= 1080 and dims["scrollWidth"] <= 1920
    excess_h = max(0, dims["scrollHeight"] - 1080)
    excess_w = max(0, dims["scrollWidth"] - 1920)

    return {
        "success": True,
        "validation_passed": passed,
        "content_height": dims["scrollHeight"],
        "content_width": dims["scrollWidth"],
        "target_height": 1080,
        "target_width": 1920,
        "excess_height": excess_h,
        "excess_width": excess_w,
        "slide_path": str(html_path),
    }


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"success": False, "error": "Usage: validate_slide.py <slide_html_path>"}))
        sys.exit(1)

    result = asyncio.run(validate(sys.argv[1]))
    print(json.dumps(result))
    sys.exit(0 if result.get("success") and result.get("validation_passed", True) else 1)


if __name__ == "__main__":
    main()
