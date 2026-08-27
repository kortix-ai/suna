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
pnpm --filter @kortix/desktop-electron dev:dev-env       # https://dev.kortix.com
pnpm --filter @kortix/desktop-electron dev:staging-env   # https://staging.kortix.com
pnpm --filter @kortix/desktop-electron dev:prod-env      # https://kortix.com
# or:
KORTIX_DESKTOP_URL=https://kortix.com/projects pnpm --filter @kortix/desktop-electron dev
```

At runtime you can also switch via the native **Kortix → Frontend URL** menu
(Production / Staging / Dev / Local / Custom… / Reset). The choice is remembered
across launches (stored in `userData/frontend_url`).

## Channels

Three builds of this shell ship, and **all three install side by side on one
machine**. `src/channel.js` is the single source of truth:

| Channel   | App name         | Bundle id                    | Scheme              | Opens                  | Published to             |
| --------- | ---------------- | ---------------------------- | ------------------- | ---------------------- | ------------------------ |
| `stable`  | Kortix           | `com.kortix.desktop`         | `kortix://`         | kortix.com             | release `vX.Y.Z`         |
| `staging` | Kortix Staging   | `com.kortix.desktop.staging` | `kortix-staging://` | staging.kortix.com     | `desktop-staging-latest` |
| `dev`     | Kortix Dev       | `com.kortix.desktop.dev`     | `kortix-dev://`     | dev.kortix.com         | `desktop-dev-latest`     |

Why every column has to differ:

- **App name** drives `app.getName()`, which drives `userData`
  (`~/Library/Application Support/<name> Desktop`). One name = one Chromium
  profile = one shared login across all three.
- **Bundle id** is the OS install identity. Two apps with one id overwrite each
  other.
- **Scheme** is the OAuth deep link. Three bundles claiming `kortix://` is a coin
  flip in LaunchServices, so signing in to the dev app could hand the code to
  prod. The web app names the scheme it wants on the callback URL
  (`desktop_scheme`, read from the shell's `KortixScheme/…` user-agent token), so
  this keeps working even when a prod install is pointed at dev via the
  Frontend URL menu.
- **Icon** is how you tell them apart in the Dock: same Kortix mark, tinted
  substrate (blue = dev, amber = staging).

Get each build from its own host: `dev.kortix.com/download`,
`staging.kortix.com/download`, `kortix.com/download`.

Build one locally:

```bash
pnpm --filter @kortix/desktop-electron pack          # stable
pnpm --filter @kortix/desktop-electron pack:staging
pnpm --filter @kortix/desktop-electron pack:dev
```

`KORTIX_CHANNEL` is the only identity input — `electron-builder.js` derives
appId, product name, icon, target URL and scheme from it. `KORTIX_VERSION`
overrides the version (CI passes the root `VERSION` file).

### Testing login (the deep link)

App login (Google etc.) opens in your **real browser** and returns to the app via
the `<scheme>://auth/callback` deep link (`kortix://` on a stable build). The OS
only routes a custom scheme to a **bundled** app, so for a clean end-to-end login
test run the packaged build:

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

Icons live in `build/` — `icon.{icns,ico,png}` for stable, `icon-dev.*` and
`icon-staging.*` for the other channels. The tinted variants are **generated**
from `icon.png` and committed:

```bash
pnpm --filter @kortix/desktop-electron icons   # regenerate after changing icon.png
```

`scripts/make-channel-icons.js` has no dependencies (PNG via `node:zlib`, `.ico`
written by hand, `.icns` via macOS `iconutil`) and is deliberately **not** a
build step: a broken image pipeline must never fail a release.

Code signing / notarization are env-driven (`CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_API_KEY*`, `WIN_CSC_LINK`, …); unsigned local builds are fine for
testing.

## Auto-update

The installed app self-updates via **electron-updater**, reading the `vX.Y.Z`
**GitHub Releases** as its feed (the `publish: github` block in
`electron-builder.js` bakes an `app-update.yml` pointing at `kortix-ai/suna`).

Flow (`src/updater.js`, wired from `src/main.js`):

1. On launch it checks GitHub for a newer release. While the splash is up it
   shows `Checking…/Downloading… N%`.
2. A newer version downloads in the **background** — the window stays usable; we
   never block on the download.
3. Once staged, a native **"Restart to update"** dialog appears. Declining keeps
   the update; it installs on the next quit (`autoInstallOnAppQuit`). A 6-hour
   re-check covers long sessions, and **Kortix → Check for Updates…** runs it on
   demand with explicit feedback.

For this to work the release must carry the electron-updater **metadata** —
`latest*.yml`, the `*.blockmap`s, and (macOS only) the update **`.zip`** that
Squirrel.Mac installs from. The dmg/exe/AppImage is the first-install download;
the zip + yml are what the updater consumes. CI (`deploy-prod.yml` for prod,
`desktop.yml` for dev) builds the mac zip target and uploads all of these to the
release.

Scope: auto-update runs only for **packaged, stable-channel** builds. Unpackaged
`electron .` dev runs can't self-update; the **`dev`** and **`staging`** channels
publish to mutable prereleases rather than versioned feeds, so they opt out — a
dev build must never cross-update itself into a prod installer. macOS additionally requires the build to be **signed +
notarized** — CI signs when the cert secrets are present.

> End-to-end note: a true download→install→relaunch can only be exercised
> against two signed, published releases. To test the *check* locally, build a
> packaged app (`pnpm build:mac`) — it will reach GitHub and either find a newer
> release or report "up to date".

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
| App login | system browser + `kortix://` | system browser + `<scheme>://` (per channel) |
| Zoom (`set_zoom`) | Rust command | `webContents.setZoomFactor` |
| Window controls | `getCurrentWindow().*` | IPC → `BrowserWindow.*` |
| Frontend URL override | app-config-dir file + menu | `userData/frontend_url` + same menu |
| Deep links | deep-link plugin | `setAsDefaultProtocolClient` + `open-url`/`second-instance` |
| Nav gate (in-app vs browser) | `on_navigation` (also fires for iframes) | `will-navigate` (top frame only) |
| Window dragging | JS `startDragging` shim | native `-webkit-app-region` CSS |
| Maximized persistence | window-state plugin (maximized only) | `userData/window_state.json` (maximized only) |
| Launch size | ~85% display, clamped | identical |
| Startup gap | blank window | branded splash window |
| Auto-update | ✗ none (manual re-download) | ✓ electron-updater (GitHub releases) |

### OAuth: two flows, handled differently (on purpose)

- **App login** (Supabase `/auth/v1/*`, Google, …) → opens in your **real
  browser**, returns via `<scheme>://auth/callback`. Same model as Tauri; Google
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
