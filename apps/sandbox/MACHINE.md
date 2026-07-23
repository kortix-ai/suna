# Kortix Sandbox

This machine is a Linux microVM.

## General Env

The runtime user is `kortix`. It has passwordless `sudo` access.
The project repository and its configuration are in `/workspace`.

Use `pnpm` for JavaScript and TypeScript dependencies. Use `pnpm dlx` for temporary package commands.
Python 3 is available as `python` and `python3`.
Use `uv run --with "pkg1,pkg2" script.py` for Python dependencies — declare them inline, comma-separated, version pins allowed. Do not create venvs or use `pip install` for one-off scripts; assume no Python packages are pre-installed.
The `--with` name is the PyPI name, which often differs from the import name: `pillow`→`PIL`, `pyyaml`→`yaml`, `python-docx`→`docx`, `python-pptx`→`pptx`, `pymupdf`→`fitz`, `opencv-python`→`cv2`, `scikit-learn`→`sklearn`, `beautifulsoup4`→`bs4`, `python-dateutil`→`dateutil`.
Never use `docx2pdf` (requires MS Word; fails on Linux) — convert Office documents with `soffice --headless --convert-to pdf`.
Use Bun only when a project requires it.

## Installed tools

- Node.js, npm, pnpm, Python, uv, Bun, OpenCode, and the `kortix` CLI are on `PATH`.
- Bundled Python tools declare their required packages in their `uv run` commands.
- `agent-browser` and Chromium are installed for accessing local pages.
- Git, curl, tmux, ffmpeg, LibreOffice, Pandoc, LaTeX, Poppler, qpdf, and Tesseract are installed.

Project-specific instructions will override this file.
