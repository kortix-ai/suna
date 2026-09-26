# Kortix Sandbox

This machine is an isolated Linux sandbox.

## General Env

The runtime user is `kortix`. It has passwordless `sudo` access.
The project repository and its configuration are in `/workspace`.

Use `pnpm` for JavaScript and TypeScript dependencies. Use `pnpm dlx` for temporary package commands.
Python 3 is available as `python` and `python3`. These packages are pre-installed: lxml, markitdown, openpyxl, pandas, pdf2docx, pdf2image, pdfplumber, pillow (`PIL`), playwright, pymupdf (`fitz`), pypdf, pypdfium2, pytesseract, python-docx (`docx`), python-pptx (`pptx`), reportlab. Run scripts that use them with plain `python3`.
For any other Python package use `uv run --with "pkg1,pkg2" script.py` — declare dependencies inline, comma-separated, version pins allowed. Do not create venvs or use `pip install` for one-off scripts.
The `--with` name is the PyPI name, which often differs from the import name: `pillow`→`PIL`, `pyyaml`→`yaml`, `python-docx`→`docx`, `python-pptx`→`pptx`, `pymupdf`→`fitz`, `opencv-python`→`cv2`, `scikit-learn`→`sklearn`, `beautifulsoup4`→`bs4`, `python-dateutil`→`dateutil`.
Never use `docx2pdf` (requires MS Word; fails on Linux) — convert Office documents with `soffice --headless --convert-to pdf`.
Use Bun only when a project requires it.

## Installed tools

- Node.js, npm, pnpm, Python, uv, Bun, OpenCode, and the `kortix` CLI are on
  `PATH`.
- Bundled Python tools run on the pre-installed package floor with plain `python3`.
- `agent-browser` and Chromium are installed for accessing local pages.
- Git, curl, tmux, ffmpeg, LibreOffice, Pandoc, LaTeX, Poppler, qpdf, and Tesseract are installed.
- Shell tools are installed: `rg` (ripgrep), `fd`, `bat`, `jq`, `fzf`, `tree`, `htop`, `lsof`, `rsync`,
  `sqlite3`, `wget`, `zip`, `unzip`, `zstd`, `git-lfs`, `ssh`, `nc`, `sponge`, and `nano`.
  Use `rg` to search file contents and `fd` to find files.

## Platform-owned binaries

Kortix owns `kortix` and `opencode` on this machine. Both are converged from
the platform's signed manifest at every session start, and OpenCode's own
autoupdate is pinned off. `kortix update` is therefore disabled here and exits
non-zero. Never install either binary from the internet: a copy in
`~/.local/bin` comes first on `PATH`, shadows the managed one, points at the
public API, and the platform cannot heal it. To move to a newer CLI, restart
the session.

`kortix tui` also refuses here — it would fetch an 80 MB binary this machine
does not manage. Run it on your own machine instead.

Project-specific instructions will override this file.
