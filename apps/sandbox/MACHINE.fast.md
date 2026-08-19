# Kortix Fast Sandbox

This machine is an isolated Linux sandbox. It uses the experimental fast cold-boot runtime.

## General environment

The runtime user is `kortix`. It has passwordless `sudo` access.
The project repository and its configuration are in `/workspace`.

Node.js, npm, pnpm, Bun, OpenCode, uv, Git, curl, tmux, and the `kortix` CLI are ready at boot.
Python installs automatically on its first `python` or `python3` command.
Use `uv run --with "pkg1,pkg2" script.py` for Python dependencies outside the document tool pack.

## Lazy tool packs

Large tools stay outside the base image. Their first command installs the required tool pack once for this sandbox.

- `agent-browser` or `chromium` installs the browser tool pack.
- `make`, `gcc`, `g++`, `cc`, `c++`, or `pkg-config` installs the development tool pack.
- `anydoc`, `libreoffice`, `pandoc`, `pdftotext`, `qpdf`, `tesseract`, `ffmpeg`, or `latexmk` installs the document tool pack.
- `kortix-toolpack development`, `kortix-toolpack browser`, `kortix-toolpack documents`, or `kortix-toolpack all` installs a pack explicitly.

The first lazy install can take several minutes. Later calls use the installed files.
Project-specific instructions override this file.
