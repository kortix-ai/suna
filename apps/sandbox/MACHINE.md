# Kortix Sandbox

This machine is an isolated Linux sandbox.

## General Env

The runtime user is `kortix`. It has passwordless `sudo` access.
The project repository and its configuration are in `/workspace`.

Use `pnpm` for JavaScript and TypeScript dependencies. Use `pnpm dlx` for temporary package commands.
Python 3 is available as `python` and `python3`. For a Python package that is not pre-installed, use `uv run --with "pkg1,pkg2" script.py` — declare dependencies inline, comma-separated, version pins allowed. Do not create venvs or use `pip install` for one-off scripts.
The `--with` name is the PyPI name, which often differs from the import name: `pillow`→`PIL`, `pyyaml`→`yaml`, `python-docx`→`docx`, `python-pptx`→`pptx`, `pymupdf`→`fitz`, `opencv-python`→`cv2`, `scikit-learn`→`sklearn`, `beautifulsoup4`→`bs4`, `python-dateutil`→`dateutil`.
Use Bun only when a project requires it.

## Installed tools

Every Kortix computer has:

- Node.js, npm, pnpm, Python, uv, Bun, and the `kortix` CLI on `PATH`.
- Git, curl, and tmux.
- Shell tools: `rg` (ripgrep), `fd`, `bat`, `jq`, `fzf`, `tree`, `htop`, `lsof`, `rsync`,
  `sqlite3`, `wget`, `zip`, `unzip`, `zstd`, `git-lfs`, `ssh`, `nc`, `sponge`, and `nano`.
  Use `rg` to search file contents and `fd` to find files.

A project agent's computer (the default image and custom templates) also has:

- These Python packages, pre-installed: lxml, markitdown, openpyxl, pandas, pdf2docx, pdf2image, pdfplumber, pillow (`PIL`), playwright, pymupdf (`fitz`), pypdf, pypdfium2, pytesseract, python-docx (`docx`), python-pptx (`pptx`), reportlab. Run scripts that use them with plain `python3`.
- `agent-browser` and Chromium.
- ffmpeg, LibreOffice, Pandoc, LaTeX, Poppler, qpdf, and Tesseract. Never use `docx2pdf` (requires MS Word; fails on Linux) — convert Office documents with `soffice --headless --convert-to pdf`.
- The desktop below, on an Ubuntu 24.04 base.

My Kortix's computer has only the first list: it hands project work to a project agent's session.

## Desktop

A project agent's computer on an Ubuntu 24.04 base runs a graphical desktop
(XFCE on display `:1`); `kortix-desktop status` says whether this one does.
The user watches it live in the session's **Desktop** panel, streamed from
port 6901.

- `DISPLAY=:1` is set, so any GUI program you start opens on the desktop.
- `agent-browser` runs headed (`AGENT_BROWSER_HEADED=true`): the user sees
  every page you open.
- The desktop has one browser, yours. The dock's browser icon and every
  `xdg-open <url>` open your default `agent-browser` session, so the user
  shares your window, tabs and logins. To have the user sign in to a site,
  open the page and ask them to take over. A tab they open becomes your
  active tab. Leave the browser open when you finish: `agent-browser close`
  closes the user's window and drops its logins.
- Browse only in the default session, with its flags as set. A named
  `--session` starts a second browser the user does not share, and a flag
  such as `--headed false` restarts the shared one.
- `curl -o shot.png localhost:6901/screenshot` captures the screen as a PNG.
- After a GUI action, `curl localhost:6901/wait` returns when the screen is
  still for 300 ms. Do not sleep.
- `curl -o clip.mp4 "localhost:6901/record?seconds=10"` records the next 10 s
  as an MP4.
- `kortix-desktop status|stop|start` controls it. `stop` frees ~380 MB of RAM.
  Then set `AGENT_BROWSER_HEADED=false` until you `start` it again.

## Platform-owned binaries

Kortix owns `kortix` on this machine. It is converged from the platform's
signed manifest at every session start. `kortix update` is therefore disabled
here and exits non-zero. Never install it from the internet: a copy in
`~/.local/bin` comes first on `PATH`, shadows the managed one, points at the
public API, and the platform cannot heal it. To move to a newer CLI, restart
the session.

`kortix tui` also refuses here — it would fetch an 80 MB binary this machine
does not manage. Run it on your own machine instead.

Project-specific instructions will override this file.
