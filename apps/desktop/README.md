# @kortix/desktop

Tauri 2 shell that wraps the existing Kortix web app. The desktop window is a
WebView pointed at the web app — there's no separate frontend to bundle. The
web app detects it's running in the desktop via the user-agent string
(`KortixDesktop/...`) and renders a custom titlebar.

## Prereqs

- **Rust 1.88+ via rustup** (Homebrew Rust 1.86 is too old for Tauri's deps).
  Install rustup once with:
  ```sh
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
  Then `rust-toolchain.toml` in `src-tauri/` pins stable automatically.
- macOS: Xcode command-line tools (`xcode-select --install`)
- Linux: `webkit2gtk` and `libsoup` dev headers (see Tauri prereqs)
- Windows: WebView2 runtime (preinstalled on Windows 11)

## Dev

```sh
# 1. Start the web app
pnpm dev:web

# 2. In another terminal, start the desktop shell
pnpm dev:desktop
```

The shell loads `http://localhost:3000` and sets the user-agent to
`KortixDesktop/0.1.0`. The web app picks that up and renders the desktop
titlebar.

## Pointing at production

Edit `src-tauri/tauri.conf.json` → `app.windows[0].url` for prod builds, or
override at runtime via the `KORTIX_DESKTOP_URL` env var (read in
`src-tauri/src/lib.rs`).

## Build

```sh
pnpm --filter @kortix/desktop build
```

Outputs a `.dmg` (macOS), `.msi` (Windows), or `.AppImage` (Linux) in
`src-tauri/target/release/bundle/`.

## Icons

The dark-variant Big Sur icon (charcoal squircle, white K, gloss + bevel,
Apple-spec drop shadow) is generated from the iOS App Icon master via:

```sh
python3 apps/desktop/scripts/build-icon.py     # → src-tauri/icons/source.png
pnpm --filter @kortix/desktop icons src-tauri/icons/source.png
```

`build-icon.py` requires Pillow (`pip install Pillow`). Edit the script to
tweak background gradient, gloss intensity, or bevel highlight.

## Phase 2 — patterns ported forward from the legacy Electron shell

The pre-`SUNA-LEGACY-cutoff` app shipped these features. Each maps cleanly to a
Tauri 2 plugin when we want to bring them back:

- **Custom URL scheme `kortix://`** for deep links (auth callbacks, email
  magic links, "open in app" buttons) → `tauri-plugin-deep-link`. The legacy
  detection helper rewrote auth callback URLs to `kortix://auth/callback`
  when running in Electron; the same swap belongs in `lib/desktop.ts` once
  the protocol is registered.
- **OAuth popup interception** via `webContents.on('will-navigate')` →
  Tauri's `WindowEvent::Navigation` or letting the IDP redirect back to a
  registered `kortix://` URL.
- **System tray, global shortcuts, native menus** → `tauri-plugin-tray`,
  `tauri-plugin-global-shortcut`, `tauri::menu`.
- **Auto-update from a hosted manifest** → `tauri-plugin-updater`.
- **Code-signing entitlements** for macOS hardened runtime are at
  `src-tauri/Entitlements.plist` (carried over from the legacy app).
