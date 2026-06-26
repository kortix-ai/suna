"""Convert HTML presentation slides to a single PDF.

Usage: uv run convert_pdf.py <presentation_dir> <output_path>

Reads metadata.json from <presentation_dir>, renders each slide HTML
at 1920x1080 via Playwright Chromium, merges into a single PDF.
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

from playwright.async_api import async_playwright
from PyPDF2 import PdfWriter, PdfReader


def find_chromium() -> str | None:
    """Auto-detect Chromium executable path for the current platform."""
    env_path = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path
    for p in ("/usr/bin/chromium-browser", "/usr/bin/chromium"):
        if os.path.isfile(p):
            return p
    return None


async def render_slide_to_pdf(
    browser, slide_info: dict, temp_dir: Path, max_retries: int = 3
) -> Path:
    """Render a single HTML slide to PDF with retry logic."""
    html_path = slide_info["path"]
    slide_num = slide_info["number"]
    last_error = None

    for attempt in range(max_retries):
        page = None
        try:
            if attempt > 0:
                await asyncio.sleep(2.0 * attempt)

            page = await browser.new_page()
            await page.set_viewport_size({"width": 1920, "height": 1080})
            await page.emulate_media(media="screen")
            await page.evaluate(
                "() => { Object.defineProperty(window, 'devicePixelRatio', { get: () => 1 }); }"
            )

            file_url = f"file://{html_path.resolve()}"
            await page.goto(file_url, wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(3000)

            await page.evaluate("""
                () => {
                    const sc = document.querySelector('.slide-container');
                    if (sc) { sc.style.width='1920px'; sc.style.height='1080px'; sc.style.transform='none'; sc.style.maxWidth='none'; sc.style.maxHeight='none'; }
                    document.body.style.margin='0'; document.body.style.padding='0';
                    document.body.style.width='1920px'; document.body.style.height='1080px';
                    document.body.style.overflow='hidden';
                }
            """)
            await page.wait_for_timeout(1000)

            temp_pdf = temp_dir / f"slide_{slide_num:02d}.pdf"
            await page.pdf(
                path=str(temp_pdf),
                width="1920px",
                height="1080px",
                margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
                print_background=True,
                prefer_css_page_size=False,
            )
            return temp_pdf

        except Exception as e:
            last_error = e
            err = str(e).lower()
            retryable = any(
                kw in err
                for kw in [
                    "target closed", "crashed", "protocol error",
                    "printtopdf", "session closed", "timeout",
                ]
            )
            if retryable and attempt < max_retries - 1:
                continue
            break
        finally:
            if page:
                try:
                    await page.close()
                except Exception:
                    pass

    raise RuntimeError(
        f"Slide {slide_num} failed after {max_retries} attempts: {last_error}"
    )


def combine_pdfs(pdf_paths: list[Path], output_path: Path) -> None:
    """Merge multiple single-page PDFs into one."""
    writer = PdfWriter()
    for p in pdf_paths:
        if p.exists():
            reader = PdfReader(str(p))
            for pg in reader.pages:
                writer.add_page(pg)
    with open(output_path, "wb") as f:
        writer.write(f)


async def convert(presentation_dir: str, output_path: str) -> dict:
    """Main conversion entrypoint."""
    pres_dir = Path(presentation_dir).resolve()
    meta_path = pres_dir / "metadata.json"

    if not pres_dir.exists():
        return {"success": False, "error": f"Directory not found: {pres_dir}"}
    if not meta_path.exists():
        return {"success": False, "error": f"metadata.json not found in {pres_dir}"}

    with open(meta_path, "r") as f:
        metadata = json.load(f)

    slides_info = []
    for num_str, data in metadata.get("slides", {}).items():
        file_path = data.get("file_path", "")
        html_path = (pres_dir.parent.parent / file_path) if file_path else None
        if html_path and html_path.exists():
            slides_info.append({
                "number": int(num_str),
                "title": data.get("title", f"Slide {num_str}"),
                "path": html_path,
            })

    if not slides_info:
        return {"success": False, "error": "No valid slides found"}

    slides_info.sort(key=lambda s: s["number"])

    launch_opts: dict = {
        "headless": True,
        "args": [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--force-device-scale-factor=1",
        ],
    }
    chromium = find_chromium()
    if chromium:
        launch_opts["executable_path"] = chromium

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        async with async_playwright() as p:
            browser = await p.chromium.launch(**launch_opts)

            try:
                sem = asyncio.Semaphore(5)

                async def render_limited(si):
                    async with sem:
                        return await render_slide_to_pdf(browser, si, tmp_path)

                pdf_paths = await asyncio.gather(
                    *[render_limited(si) for si in slides_info]
                )
            finally:
                await browser.close()

        sorted_paths = sorted(pdf_paths, key=lambda p: int(p.stem.split("_")[1]))
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        combine_pdfs(sorted_paths, out)

    return {
        "success": True,
        "output_path": str(out),
        "total_slides": len(slides_info),
    }


def main():
    if len(sys.argv) != 3:
        print(json.dumps({"success": False, "error": "Usage: convert_pdf.py <presentation_dir> <output_path>"}))
        sys.exit(1)

    result = asyncio.run(convert(sys.argv[1], sys.argv[2]))
    print(json.dumps(result))
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()
