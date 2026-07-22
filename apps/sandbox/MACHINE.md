# Kortix Sandbox

This machine is a Linux microVM.

## General Env

The runtime user is `kortix`. It has passwordless `sudo` access.
The project repository and its configuration are in `/workspace`.

Use `pnpm` for JavaScript and TypeScript dependencies. Use `pnpm dlx` for temporary package commands.
Python 3 is available as `python` and `python3`.
Use `uv run --with <package>` for Python dependencies.
Use Bun only when a project requires it.

## Installed tools

- Node.js, npm, pnpm, Python, uv, Bun, OpenCode, and the `kortix` CLI are on `PATH`.
- Bundled Python tools declare their required packages in their `uv run` commands.
- `agent-browser` and Chromium are installed for accessing local pages.
- Git, curl, tmux, ffmpeg, LibreOffice, Pandoc, LaTeX, Poppler, qpdf, and Tesseract are installed.

Project-specific instructions will override this file.
