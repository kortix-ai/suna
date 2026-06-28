# @kortix/desktop-electron

An **Electron** build of the Kortix desktop shell, built as a 1:1 behavioral
port of the Tauri shell (`apps/desktop`). It exists so we can compare the two
side by side and pick whichever is less quirky to maintain.

Both shells are thin native wrappers around the **remote** web app
(`http://localhost:3000` in dev, `https://kortix.com` in prod). They share the
same web codebase unchanged — see "Parity" below.

## Why an Electron port?

Tauri's macOS WKWebView routes **every** navigation, including cross-origin
`<iframe>` loads, through the Rust `on_navigation` hook. That broke the
Pipedream **Connect** overlay (an iframe to
`pipedream.com/_static/connect.html`): it got punted to the system browser and
failed with **"Must be inside iframe."** Electron's `will-navigate` fires for
the **top frame only**, so embedded iframes "just work" — no allow-list needed.
(The Tauri shell is also fixed, by allow-listing `pipedream.com` for iframe
loads.)

Electron also gives us native `-webkit-app-region` window dragging (Tauri needs
a JS mousedown→`startDragging` shim), a real branded splash window for the
remote-load gap, and fewer WKWebView surprises generally.

## Run it (dev)

```bash
pnpm install                  # at repo root (Electron binary self-downloads on first `dev` — see note)
pnpm dev                      # repo root: start the web app on :3000
pnpm dev:desktop-electron     # repo root: launch the Electron shell → :3000
```

> Note: this repo sets `ignore-scripts=true` and runs pnpm 8, so Electron's
> binary doesn't download during `pnpm install`. The `dev` script self-heals via
> `scripts/ensure-runtime.js` (it fetches the runtime on first launch).

Point it at a different backend without a rebuild:

```bash
pnpm --filter @kortix/desktop-electron dev:dev-env    # https://dev.kortix.com
pnpm --filter @kortix/desktop-electron dev:prod-env   # https://kortix.com
# or:
KORTIX_DESKTOP_URL=https://kortix.com/projects pnpm --filter @kortix/desktop-electron dev
```

At runtime you can also switch via the native **Kortix → Frontend URL** menu
(Production / Dev / Local / Custom… / Reset). The choice is remembered across
launches (stored in `userData/frontend_url`).

### Testing login (the `kortix://` deep link)

App login (Google etc.) opens in your **real browser** and returns to the app via
the `kortix://auth/callback` deep link. The OS only routes `kortix://` to a
**bundled** app, so for a clean end-to-end login test run the packaged build:

```bash
pnpm --filter @kortix/desktop-electron dev:macos   # builds an unpacked .app + opens it
```

Plain `pnpm dev` (unpackaged `electron .`) is great for fast iteration, and your
session persists across relaunches — but a *fresh* login won't round-trip back
until you run the bundled build above.

## Package

```bash
pnpm build            # current OS  → dist/
pnpm build:mac | build:win | build:linux
```

Icons live in `build/` (`icon.icns` / `icon.ico` / `icon.png`). Code signing /
notarization are env-driven (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY*`,
`WIN_CSC_LINK`, …); unsigned local builds are fine for testing.

## Parity with the Tauri shell

The web app talks to the native shell through exactly one module —
`apps/web/src/lib/desktop.ts` — which uses `window.__TAURI__` and the
`KortixDesktop` user-agent token. This port reproduces **both**, so the web app
runs **unchanged** on either shell:

| Concern | Tauri (`apps/desktop`) | Electron (this app) |
| --- | --- | --- |
| Detection | `KortixDesktop` UA token | same token appended to UA |
| Native bridge | `window.__TAURI__` (global Tauri) | `window.__TAURI__` shim in `preload.js` |
| External `_blank` links | JS shim → `open_external` IPC | `setWindowOpenHandler` → `shell.openExternal` |
| OAuth/connect popups (Pipedream) | ✗ blocked (`window.open`→null) | ✓ real child window (works) |
| App login | system browser + `kortix://` | system browser + `kortix://` |
| Zoom (`set_zoom`) | Rust command | `webContents.setZoomFactor` |
| Window controls | `getCurrentWindow().*` | IPC → `BrowserWindow.*` |
| Frontend URL override | app-config-dir file + menu | `userData/frontend_url` + same menu |
| Deep links (`kortix://`) | deep-link plugin | `setAsDefaultProtocolClient` + `open-url`/`second-instance` |
| Nav gate (in-app vs browser) | `on_navigation` (also fires for iframes) | `will-navigate` (top frame only) |
| Window dragging | JS `startDragging` shim | native `-webkit-app-region` CSS |
| Maximized persistence | window-state plugin (maximized only) | `userData/window_state.json` (maximized only) |
| Launch size | ~85% display, clamped | identical |
| Startup gap | blank window | branded splash window |

### OAuth: two flows, handled differently (on purpose)

- **App login** (Supabase `/auth/v1/*`, Google, …) → opens in your **real
  browser**, returns via `kortix://auth/callback`. Same model as Tauri; Google
  rejects embedded webviews and a real browser is the trustworthy place to sign
  in. The nav gate routes any `/auth/v1/*` navigation out to the browser.
- **Pipedream Connect / connector popups** → open **in-app** as a child window.
  Pipedream opens the provider via `window.open` and waits for a `postMessage`
  back into its iframe — that handshake only works with a real popup that has a
  `window.opener`. **This is the bug Tauri can't fix** ("Connect account popup
  blocked"): Tauri forces `window.open` to return `null`. Electron's
  `setWindowOpenHandler` returns a genuine child window, so it works.

### Known caveat

- Prod sandbox previews served over plain HTTP inside an HTTPS page are
  mixed-content; Chromium is stricter than WKWebView here. Revisit if it bites.
