#!/usr/bin/env python3
"""
Create an HTML contact sheet for comparing logo variations side by side.

Usage:
    python3 create_logo_sheet.py <image_dir> <output_html> [--title "Sheet Title"] [--cols 3]

Scans <image_dir> for .png/.jpg/.webp files, generates a self-contained HTML
page with a dark grid layout, modal zoom on click, and light/dark background
toggle per logo.

Example:
    python3 create_logo_sheet.py ./logos ./logos/sheet.html --title "Acme Logomarks Round 1"
"""

import sys
import os
import base64
import argparse
from pathlib import Path


def image_to_data_uri(path: str) -> str:
    """Convert image file to base64 data URI for self-contained HTML."""
    ext = Path(path).suffix.lower()
    mime = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
    }.get(ext, "image/png")
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{data}"


def find_images(directory: str) -> list[str]:
    """Find all image files in directory, sorted by name."""
    exts = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
    images = []
    for entry in sorted(os.listdir(directory)):
        if Path(entry).suffix.lower() in exts:
            full = os.path.join(directory, entry)
            if os.path.isfile(full):
                images.append(full)
    return images


def generate_html(images: list[str], title: str, cols: int) -> str:
    """Generate self-contained HTML contact sheet."""

    cards = []
    for i, img_path in enumerate(images):
        name = Path(img_path).stem
        data_uri = image_to_data_uri(img_path)
        cards.append(
            f"""
      <div class="card" onclick="openModal({i})">
        <div class="img-wrap" id="wrap-{i}">
          <img src="{data_uri}" alt="{name}" draggable="false" />
        </div>
        <div class="card-footer">
          <span class="card-name">{name}</span>
          <button class="bg-toggle" onclick="event.stopPropagation(); toggleBg({i})" title="Toggle background">
            &#x25D1;
          </button>
        </div>
      </div>"""
        )

    modal_data = []
    for i, img_path in enumerate(images):
        data_uri = image_to_data_uri(img_path)
        name = Path(img_path).stem
        modal_data.append(f'{{src:"{data_uri}",name:"{name}"}}')

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{title}</title>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ background:#111; color:#eee; font-family:'Inter','Segoe UI',system-ui,sans-serif; padding:30px; }}
  h1 {{ font-size:28px; font-weight:700; margin-bottom:8px; }}
  .meta {{ font-size:14px; color:#888; margin-bottom:24px; }}
  .grid {{
    display:grid;
    grid-template-columns:repeat({cols}, 1fr);
    gap:16px;
  }}
  .card {{
    border:1px solid #333; border-radius:12px; overflow:hidden;
    cursor:pointer; transition:border-color .2s, transform .15s;
    background:#1a1a1a;
  }}
  .card:hover {{ border-color:#666; transform:translateY(-2px); }}
  .img-wrap {{
    aspect-ratio:1; display:flex; align-items:center; justify-content:center;
    padding:20px; background:#fff; transition:background .2s;
  }}
  .img-wrap.dark {{ background:#1a1a1a; }}
  .img-wrap img {{ max-width:100%; max-height:100%; object-fit:contain; }}
  .card-footer {{
    display:flex; align-items:center; justify-content:space-between;
    padding:10px 14px; font-size:13px; color:#aaa;
  }}
  .card-name {{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80%; }}
  .bg-toggle {{
    background:none; border:1px solid #555; color:#aaa; border-radius:6px;
    width:28px; height:28px; cursor:pointer; font-size:16px; line-height:1;
    display:flex; align-items:center; justify-content:center; transition:border-color .2s;
  }}
  .bg-toggle:hover {{ border-color:#aaa; color:#fff; }}

  /* Modal */
  .modal-overlay {{
    display:none; position:fixed; inset:0; background:rgba(0,0,0,.85);
    z-index:1000; align-items:center; justify-content:center;
  }}
  .modal-overlay.open {{ display:flex; }}
  .modal-content {{
    position:relative; max-width:80vw; max-height:80vh;
    display:flex; flex-direction:column; align-items:center;
  }}
  .modal-content img {{ max-width:80vw; max-height:72vh; object-fit:contain; border-radius:8px; }}
  .modal-name {{ margin-top:12px; font-size:16px; color:#ccc; }}
  .modal-close {{
    position:fixed; top:20px; right:30px; font-size:36px; color:#888;
    cursor:pointer; z-index:1001; line-height:1; background:none; border:none;
  }}
  .modal-close:hover {{ color:#fff; }}
  .modal-nav {{
    position:fixed; top:50%; font-size:48px; color:#666; cursor:pointer;
    z-index:1001; background:none; border:none; transform:translateY(-50%);
    padding:10px; transition:color .2s;
  }}
  .modal-nav:hover {{ color:#fff; }}
  .modal-prev {{ left:20px; }}
  .modal-next {{ right:20px; }}
  .modal-bg-toggle {{
    position:fixed; bottom:30px; left:50%; transform:translateX(-50%);
    background:#333; border:1px solid #555; color:#ccc; border-radius:8px;
    padding:8px 20px; font-size:14px; cursor:pointer; z-index:1001;
  }}
  .modal-bg-toggle:hover {{ background:#444; color:#fff; }}
  .modal-img-wrap {{
    background:#fff; border-radius:8px; padding:30px; transition:background .2s;
    display:flex; align-items:center; justify-content:center;
  }}
  .modal-img-wrap.dark {{ background:#1a1a1a; }}

  /* Counter badge */
  .counter {{
    position:fixed; bottom:30px; right:30px; background:#333; border:1px solid #555;
    border-radius:8px; padding:6px 14px; font-size:13px; color:#888; z-index:1001;
    display:none;
  }}
  .modal-overlay.open ~ .counter {{ display:block; }}
</style>
</head>
<body>
  <h1>{title}</h1>
  <div class="meta">{len(images)} variations</div>
  <div class="grid">
    {''.join(cards)}
  </div>

  <div class="modal-overlay" id="modal">
    <button class="modal-close" onclick="closeModal()">&times;</button>
    <button class="modal-nav modal-prev" onclick="navModal(-1)">&#8249;</button>
    <button class="modal-nav modal-next" onclick="navModal(1)">&#8250;</button>
    <div class="modal-content">
      <div class="modal-img-wrap" id="modal-img-wrap">
        <img id="modal-img" src="" alt="" />
      </div>
      <div class="modal-name" id="modal-name"></div>
    </div>
    <button class="modal-bg-toggle" onclick="toggleModalBg()">Toggle Background</button>
  </div>
  <div class="counter" id="counter"></div>

<script>
  const data = [{','.join(modal_data)}];
  let current = 0;

  function openModal(i) {{
    current = i;
    showModal();
  }}
  function showModal() {{
    const m = document.getElementById('modal');
    document.getElementById('modal-img').src = data[current].src;
    document.getElementById('modal-name').textContent = data[current].name;
    document.getElementById('counter').textContent = (current+1) + ' / ' + data.length;
    m.classList.add('open');
    document.getElementById('counter').style.display = 'block';
  }}
  function closeModal() {{
    document.getElementById('modal').classList.remove('open');
    document.getElementById('counter').style.display = 'none';
  }}
  function navModal(dir) {{
    current = (current + dir + data.length) % data.length;
    showModal();
  }}
  function toggleBg(i) {{
    document.getElementById('wrap-' + i).classList.toggle('dark');
  }}
  function toggleModalBg() {{
    document.getElementById('modal-img-wrap').classList.toggle('dark');
  }}
  document.addEventListener('keydown', e => {{
    const m = document.getElementById('modal');
    if (!m.classList.contains('open')) return;
    if (e.key === 'Escape') closeModal();
    if (e.key === 'ArrowLeft') navModal(-1);
    if (e.key === 'ArrowRight') navModal(1);
    if (e.key === 'b' || e.key === 'B') toggleModalBg();
  }});
</script>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser(description="Generate an HTML logo contact sheet.")
    parser.add_argument("image_dir", help="Directory containing logo images")
    parser.add_argument("output_html", help="Path for the output HTML file")
    parser.add_argument("--title", default="Logo Variations", help="Sheet title")
    parser.add_argument("--cols", type=int, default=3, help="Grid columns (default: 3)")
    args = parser.parse_args()

    if not os.path.isdir(args.image_dir):
        print(f"Error: '{args.image_dir}' is not a directory")
        sys.exit(1)

    images = find_images(args.image_dir)
    if not images:
        print(f"Error: No images found in '{args.image_dir}'")
        sys.exit(1)

    html = generate_html(images, args.title, args.cols)

    os.makedirs(os.path.dirname(os.path.abspath(args.output_html)), exist_ok=True)
    with open(args.output_html, "w") as f:
        f.write(html)

    print(f"Created contact sheet: {args.output_html}")
    print(f"  Images: {len(images)}")
    print(f"  Columns: {args.cols}")


if __name__ == "__main__":
    main()
