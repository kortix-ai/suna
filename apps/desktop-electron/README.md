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

At runtime you can also switch via the native menu. A **dev build**
(`kortixUpdateChannel: "dev"`, product "Kortix Dev") keeps the full
**Kortix → Frontend URL** switcher (Production / Dev / Local / Custom… /
Reset). A **production build** hides the developer presets and shows one
**Kortix → Change Kortix Instance…** item that opens the same instance-chooser
window as first launch, so a self-hoster still sets a custom URL. The choice is
remembered across launches (stored in `userData/frontend_url`).
`KORTIX_DESKTOP_USER_DATA=<dir>` runs against an isolated profile instead of
the real one.

### First launch: choose a Kortix instance

A new profile asks which instance to connect to before any page loads. The
window is `src/instance-chooser.js` + `assets/instance-chooser.html`; URL rules
and the reachability check are `src/instance-rules.js`; `frontend_url`, the
first-launch marker, and URL precedence are `src/instance-store.js`.

- **Kortix Cloud** — the URL baked in at build time (`kortix.com` for prod,
  `dev.kortix.com` for dev builds). Nothing is written to `frontend_url`, so the
  app keeps following the baked default.
- **Self-hosted** — the URL the user types. A bare host gets `https://` (a bare
  `localhost` gets `http://`), a `/` path becomes `/projects`, and query and
  fragment are dropped. URLs with a username or password are rejected. The app
  sends `HEAD` with no credentials and an 8 s timeout; any HTTP status counts as
  reachable. A network error shows inline, with **Continue Anyway** for hosts
  that are only reachable on a VPN. The URL is saved to `frontend_url`.

Rules:

- "New profile" = `userData` is missing or empty at process start. The shell
  then writes `userData/instance_setup_pending` and removes it once the user
  chooses. Quitting the chooser asks again on the next launch.
- Existing installs have a non-empty `userData` and are never asked.
- `KORTIX_DESKTOP_URL` or a saved `frontend_url` skips the chooser, so
  `pnpm dev` and the native e2e journey never see it.

The same window opens from the frontend-URL menu entry (**Frontend URL →
Custom URL…** on dev builds, **Change Kortix Instance…** on production builds),
and when the app origin fails to load (`did-fail-load` on the main frame): the
title reads
**Can't reach \<host\>**, with **Try Again** or a different instance. To see the
first-launch chooser locally, launch without `KORTIX_DESKTOP_URL` on an empty
profile:

```bash
pnpm --filter @kortix/desktop-electron run setup
KORTIX_DESKTOP_USER_DATA="$(mktemp -d)" pnpm --filter @kortix/desktop-electron exec electron .
```

### The dev/staging environment password (HTTP Basic)

`dev.kortix.com` and `staging.kortix.com` sit behind one shared HTTP Basic
credential (`apps/web/src/middleware.ts` answers `401 Authentication required.`).
Chrome pops its own username/password dialog for that; Electron does not, so the
shell handles the challenge itself (`src/main.js` → `answerBasicChallenge`, policy
in `src/basic-auth.js`):

1. `KORTIX_DESKTOP_BASIC_PASSWORD` (+ optional `KORTIX_DESKTOP_BASIC_USER`,
   default `kortix`) answers silently — for CI and scripted launches.
2. Otherwise a credential the user entered earlier for that host answers
   silently. "Remember on this device" stores it in `userData/basic_auth.json`,
   encrypted with Electron `safeStorage` (macOS Keychain / DPAPI / libsecret).
3. Otherwise a native-style sign-in dialog (`assets/basic-auth.html`) opens over
   the app window. A rejected password (the server re-challenges within 60 s)
   drops the remembered copy and reopens the dialog with an error. Cancel leaves
   the bare 401 page, like Chrome; reload asks again.

Origin credentials are sent only to the configured app origin. Any other
origin challenge from a sandbox preview or iframe is refused. Proxy challenges
open the same dialog, but use a separate credential entry keyed by proxy host
and port. The app-origin environment variables never answer a proxy challenge.
**Kortix → Frontend URL → Forget Saved Environment Password** (dev builds)
clears the remembered credential for the current host.

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

## This computer (local agent + tray)

The app bundles the computer agent, `@kortix/agent-tunnel`
(`packages/agent-tunnel/dist/agent-cli.js`), as
`Resources/agent-tunnel/agent-cli.js`, with the package's `package.json` beside
it for the version (electron-builder `extraResources`; `desktop.yml` stamps the
release version into that `package.json`, because the checked-in value is inert). It
runs that file with its own binary: `process.execPath` +
`ELECTRON_RUN_AS_NODE=1`. The installed OS service (launchd / systemd user unit
/ Scheduled Task) does the same, so a connected computer needs no Node install.
Dev runs load the repo build; `scripts/ensure-runtime.js` builds it with bun
when it is missing.

Pieces: `src/computer.js` (rules, NDJSON parsing, spawning, access.json;
unit-tested) and `src/computer-tray.js` (commands, approval window, access
prompt, tray).

| `kortix:invoke` command | Result |
| --- | --- |
| `computer_status` | `{ available, paired, tunnelId?, apiUrl?, status?, state?, paused, serviceInstalled, serviceActive, needsRepair, error? }`. `state` is `online`, `connecting`, `offline`, `rejected` (needs reconnect) or `standby`. Answered from the cached status; file changes keep it fresh. |
| `computer_connect { projectId?, share?, apiUrl?, reauth? }` | Runs `connect --json --daemon --api-url <backend>/tunnel [--project-id <id>] [--reauth]`; opens the approval page in a modal window; resolves `{ ok, tunnelId, existing? }` or `{ ok: false, error }` once the service is installed. `share` is chosen on the approval page. |
| `computer_pause` / `computer_resume` | The agent's durable `stop` / `start`. Returns `{ ok, error?, status }`. Pause survives login and reboot. |
| `computer_disconnect` | `logout --json`: removes the machine in Kortix with its own credential (`DELETE /v1/tunnel/self`), then the local credential and the service. Returns `{ ok, serverUnpaired, error?, status }`. |
| `computer_open_logs` | Opens `logs/agent-tunnel.out.log`; rejects when the OS cannot open it. |
| `computer_access_get` | `{ mode, grantedUntil, deniedUntil, keepAwake, keepAwakeSupported, pendingRequest }` |
| `computer_access_set { mode?, grantMinutes?, revoke?, keepAwake? }` | Writes `access.json` (grant at most 24 h); returns the same shape. |

Rules:

- The commands pass the same trusted-sender gate as every other command: the
  main frame of the main window, on the configured app origin.
- **The backend comes from the instance, not the page.** The main process reads
  `BACKEND_URL` from `<app origin>/api/runtime-config` (https, or http on
  loopback) and caches it in `<userData>/computer-backend.json` for offline
  starts. A page that still passes `apiUrl` must name exactly that backend.
- The approval URL loads in-app only when it is this app's `/tunnel/` route;
  anything else opens in the system browser. Closing that window cancels the
  pairing only when no approval arrives within 10 s: the agent learns of an
  approval on its next 2 s poll.
- A packaged macOS app must run from `/Applications`; a translocated copy would
  leave the service pointing at a path that disappears.
- **Isolation, one identity per backend.** A packaged **stable** build on
  `https://api.kortix.com` uses the default `~/.agent-tunnel` and service
  `ai.kortix.agent-tunnel`, the same identity as the npm CLI. So does a stable
  build whose `~/.agent-tunnel` already pairs the same backend. Every other
  backend gets `AGENT_TUNNEL_HOME=<userData>/agent-tunnel/<sha8(api origin)>`
  and a suffixed service `ai.kortix.agent-tunnel.<8 hex>`. A pre-v2
  `<userData>/agent-tunnel` keeps being used while it pairs the same backend.
  A packaged stable build uses `~/.agent-tunnel` only when it is unpaired or
  paired with this same backend. A saved token is never sent to another
  backend, and `pnpm dev` never touches the real agent.
- **Service repair.** On start, and from the periodic status refresh at most
  once every 5 minutes, a paired service that is not paused is reinstalled
  (`install-service`) when it is missing, not running, its unit differs from
  what this app would write (app moved or updated), or it runs an agent version
  other than the bundled one. A foreground `agent-tunnel connect` that holds
  the tunnel is left alone. On macOS a copy that does not run from the
  Applications folder (disk image, App Translocation) never repairs and never
  records itself.
- **Access prompt.** The app records itself in `<home>/desktop-app.json` (the
  AppImage file on Linux) and touches it every 5 s, so the agent can tell a
  running app from a reused pid and start it. When `access-request.json`
  appears and access is not already decided, the app shows a native dialog on
  top of every app ("Allow Kortix to use <machine>?": Allow for 24 hours, Allow
  for 1 hour (default), Deny). The dialog says a grant covers files, the shell,
  and the screen and keyboard for any agent that can reach the computer. A
  system notification appears when no window has focus. An answer clears every
  request asked before it.
- **Access from the web page.** `computer_access_set` narrows access at once
  (Off, Ask each time, Revoke, keep awake). Widening it (Always allowed, or a
  new grant) applies only after the owner clicks Allow in a native dialog: the
  page is remote content and never decides alone. A mode change drops the old
  grant and denial.

The tray (macOS menu bar template icon, Windows/Linux notification area) exists
while a computer is paired. Its status line follows `state.json` (fs.watch plus
a 5 s mtime poll; a full status refresh every 60 s). Items: Open Kortix; Access
(Ask each time / Always allowed / Off); "Allowed until HH:MM" and Revoke now
while a grant runs; Keep this computer awake while plugged in (macOS, Linux;
shown disabled on Windows); Pause/Resume computer access; Show logs;
Open at login (macOS and Windows); Disconnect this computer… (same self-unpair
as the web); Quit Kortix. Failures show an error dialog. With a paired
computer, closing the last window keeps the app in the tray on every platform.
The agent is a separate OS service and stays connected after Quit.

Tray icons are in `assets/tray/`: `trayTemplate.png` / `@2x` (black + alpha,
from `apps/web/public/kortix-symbol.svg`) and `tray.png` / `tray.ico` (from
`build/icon.png`).

## Package

```bash
pnpm build            # current OS  → dist/
pnpm build:mac | build:win | build:linux
```

Icons live in `build/` (`icon.icns` / `icon.ico` / `icon.png`). Code signing /
notarization are env-driven (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY*`,
`WIN_CSC_LINK`, …); unsigned local builds are fine for testing.

## Auto-update

The installed app self-updates via **electron-updater**, reading the `vX.Y.Z`
**GitHub Releases** as its feed (the `publish: github` block in
`electron-builder.yml` bakes an `app-update.yml` pointing at `kortix-ai/suna`).

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
`electron .` dev runs can't self-update; the **`dev`** channel (the mutable
`desktop-dev-latest` prerelease) opts out so a dev build never cross-updates to a
prod installer. macOS additionally requires the build to be **signed +
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
| App login | system browser + `kortix://` | system browser + `kortix://` |
| Zoom (`set_zoom`) | Rust command | `webContents.setZoomFactor` |
| Window controls | `getCurrentWindow().*` | IPC → `BrowserWindow.*` |
| Frontend URL override | app-config-dir file + menu | `userData/frontend_url` + same menu |
| Deep links (`kortix://`) | deep-link plugin | `setAsDefaultProtocolClient` + `open-url`/`second-instance` |
| Nav gate (in-app vs browser) | `on_navigation` (also fires for iframes) | `will-navigate` (top frame only) |
| Window dragging | JS `startDragging` shim | native `-webkit-app-region` CSS |
| Window-state persistence | window-state plugin (maximized only) | `userData/window_state.json` (bounds and maximized state; off-screen bounds recenter) |
| Launch size | ~85% display, clamped | identical |
| Startup gap | blank window | branded splash window |
| Auto-update | ✗ none (manual re-download) | ✓ electron-updater (GitHub releases) |

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
