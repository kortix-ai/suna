# Mobile device check and OTA hand-off (plan 5, task 7)

This file is the on-device checklist for generative UI on mobile, and the
procedure to publish it as an EAS Update. Jay runs it on a real device. No
simulator is used. The agent publishes nothing: an OTA publish reaches every
installed app on the channel and needs Jay's explicit approval.

## Preconditions

1. The backend the app talks to runs the genui runtime from branch `genui`:
   the `genui` project flag, `KORTIX_GENUI` in the sandbox env, and the kortixd
   prompt. `dev-api.kortix.com` has it only after `genui` merges to `dev` and
   dev deploys. Before that, point the app at the worktree's local stack
   (`pnpm worktree start genui`, then set `EXPO_PUBLIC_BACKEND_URL` to an
   address the phone can reach, for example the cloudflared tunnel URL plus
   `/v1`).
2. Turn the flag on for one test project. Use one of:
   - web: Project settings → Feature flags → Generative UI;
   - CLI: `kortix projects features enable genui --project <project_id>`
     (without `--project`, the linked or default project).
   The flag applies to **new** sessions. Start a new session after you turn it
   on. A running or restarted session keeps its old prompt. A warm session
   keeps the prompt it was provisioned with, and both web and the phone create
   one when they open the project (the phone also on return to the
   foreground), then reuse it for the next new session. So do one of:
   - turn the flag on before any client (web or phone) opens the test
     project; or
   - turn warm sessions off for the test project first:
     `kortix projects features disable warm_sessions --project <project_id>`,
     and turn them back on with `kortix projects features reset warm_sessions
     --project <project_id>` after the check.
3. Start Metro from the `genui` worktree's `apps/mobile` directory. Copy
   `apps/mobile/.env` from the primary checkout first (the file is gitignored;
   edit `EXPO_PUBLIC_BACKEND_URL` if needed), then run `pnpm dev`
   (`expo start -c`).
   `EXPO_PUBLIC_*` values are compiled into the bundle. After you change one,
   stop Metro and run `pnpm dev` again (`-c` clears the cache).
4. Expo SDK: branch `genui` includes `dev` up to the merge `09dd34b035`, so it
   is on Expo SDK 57 (`expo` `~57.0.27`) and runtime `1.5.0`
   (`apps/mobile/app.json`). Use Expo Go for SDK 57 or a `1.5.0` dev build.
   Expo Go and any binary without the `react-native-uitextview` native module
   use the iOS double-tap selection sheet (step 8).
5. Settings → Rich answers is on (the default).

Record for each step: pass or fail, device model, OS, theme. A failure goes
back to the plan-5 task that owns the component.

## Checklist

Send each prompt in a new session of the test project unless the step says
otherwise. "Never shows `root =`" means: at no moment during or after the
stream does OpenUI source text appear in the transcript.

### 1. Option cards stream in

- Prompt: `Compare these two plans: Basic 10 USD with 3 projects; Pro 30 USD with unlimited projects.`
- Expected: two option cards appear and fill in while the reply streams. The
  text `root = ` never shows. When the stream ends, both cards show the price
  and the project limit.

### 2. Bar chart, legend, source, Show data

- Prompt: `Show me revenue by quarter: Q1 120, Q2 150, Q3 170.`
- Expected: a bar chart with three bars (Q1, Q2, Q3), a one-entry legend
  above the plot with the series name (for example `Revenue`), and a
  `Source: ...` line under it. A chart with 2 or more series has one legend
  entry per series. Tap **Show data**: a table with the same three
  values appears and the button reads **Hide data**. Tap again: the table
  closes.

### 3. Tables scroll sideways, the drawer stays

- Prompt: `Make a table of these laptops with columns name, price, memory, weight, battery, screen, ports: Laptop 1 899 USD 16 GB 1.3 kg 12 h 13 in 2xUSB-C; Laptop 2 1199 USD 16 GB 1.1 kg 15 h 14 in 3xUSB-C; Laptop 3 649 USD 8 GB 1.6 kg 9 h 15 in 2xUSB-A.`
- Expected: the table is wider than the screen. Swipe left and right on the
  table: the table scrolls sideways. The session drawer does not open and the
  transcript does not move sideways. A swipe from the screen edge outside the
  table still opens the drawer.

### 4. Accordion caret and reduced motion

- Prompt: `Answer as an accordion with three sections: Setup, Billing, Support. One sentence each.`
- Expected: three rows, each with a caret on the right. Tap a row: its content
  appears below at once (no height animation) and the caret turns 180° in
  about 200 ms with a quick ease-out. Tap again: the caret turns back and the
  content hides. Rows open independently.
- Reduced motion: turn on iOS Settings → Accessibility → Motion → Reduce
  Motion (Android: Settings → Accessibility → Remove animations). Tap a row
  again: the caret snaps to its end position with no turn.

### 5. Map rows, Open map, with and without a style URL

Prompt for both runs:
`Show the delivery route on a map. Stops in order: Depot 51.5074, -0.1278; Stop A 51.5155, -0.0922; Stop B 51.5033, -0.1196; Stop C 51.4975, -0.1357.`

a. `EXPO_PUBLIC_GENUI_MAP_STYLE_URL` empty (the default in `.env.example`):
   - Expected: one row per stop with a pin icon, then a `Source: ...` line.
     A stop the model gave a description shows it as a second, muted line
     under the name (one line, truncated). There is no **Open map** row.
     Tap a stop: the browser opens openstreetmap.org at that point. No map
     draws in the transcript.

b. Set `EXPO_PUBLIC_GENUI_MAP_STYLE_URL="https://tiles.openfreemap.org/styles/liberty"`
   in `apps/mobile/.env`, restart Metro with `pnpm dev`, and send the prompt in
   a new session:
   - Expected: the first row is **Open map**, then the stop rows. Tap
     **Open map**: a full-screen dialog shows a loader, then the map with four
     markers and the route line (when the model includes a route). The
     attribution control is the compact one: an `i` button that expands to
     the attribution text. Pan and pinch move only the map. Tap a marker: its
     popup shows the name, and the description when there is one. Expand the
     attribution if it is collapsed, then tap its `OpenStreetMap` link: the
     browser opens the link and the app stays on the dialog. Close the
     dialog.
   - Scroll the transcript up and down over the map block: the transcript
     scrolls. No map moves, because no map renders in the transcript.
   - Turn on airplane mode, then tap **Open map** again. Verify on device:
     the dialog opens and no tiles draw, because the style cannot load. The
     page (`map-html.ts`) builds the zoom buttons, the attribution control
     and one marker pin per stop without waiting for the style, so the pins
     and the controls can still show on the empty surface; the route line
     cannot, because it is added only after the style loads. The app does
     not crash. The MapLibre files are read once per app run, so this open
     does not need the network for them. `Map unavailable` shows only when
     that read fails (for example, the first open of an app run with Metro
     unreachable).

### 6. Rich answers switch

- Go to Settings → Preferences → **Rich answers**. Turn it off.
- Open the sessions from steps 1 and 2.
- Expected: the blocks show as markdown text (the plans as text, the chart as
  a markdown table with a `Source: ...` line). The text `root = ` never shows.
- Turn **Rich answers** on: the same messages show the cards and the chart
  again, with no app restart.

### 7. Status chips and callouts, light and dark

- Prompt: `Give me a project status card with three status badges: Build good, Tests warn, Deploy bad. Then add one info callout, one warn callout, and one success callout, one sentence each.`
- Expected in light theme: neutral, good (green), warn (amber), and bad (red)
  chips each have a 15% tint (neutral uses the secondary surface) and
  foreground-color text. The info (blue), warn (amber), and success (green)
  callouts each have a 15% tint, an icon, and foreground-color text.
- Switch to dark theme (Settings → Preferences → Appearance): the same tints
  read on the dark surface. Text keeps its contrast. No chip or callout shows
  a light box on dark.

### 8. Copy and the iOS selection sheet show markdown

- On the turn from step 2, tap the turn's **Copy** action. Paste into Notes.
- Expected: the pasted text contains a markdown table with rows Q1, Q2, Q3
  and a `Source: ...` line. It never contains `root =` or OpenUI calls.
- iOS selection sheet: only on a binary without the `react-native-uitextview`
  native module (Expo Go, or an older store build). Double-tap the reply text,
  or the block inside it: the **Select Text** sheet opens. Expected: the sheet
  shows the markdown version of the whole reply, including the block, never
  OpenUI source. With Rich answers off, a double tap on the block's markdown
  opens the same whole-reply sheet. Builds with the native module have no
  sheet: a long-press selects text in place, and there is nothing to check.

### 9. Light, dark, Android, iOS

- Repeat steps 1, 2, and 5 in light and in dark theme.
- Repeat on Android and iOS if both devices are available. Android mirrors
  iOS: the same rows, the same tints, the same gestures.

### 10. Streaming smoothness (spec §8.4)

- Open the Expo dev menu → **Toggle performance monitor**.
- Prompt: `Which laptop is best for a student? Laptop 1: 899, 16 GB, 1.3 kg, 12 h. Laptop 2: 1199, 16 GB, 1.1 kg, 15 h. Laptop 3: 649, 8 GB, 1.6 kg, 9 h. Laptop 4: 999, 32 GB, 1.8 kg, 10 h.`
  (eval case `ui-four-products`).
- Spec §8.4 compares against `dev`, not against Rich answers off. Run the
  prompt twice on the same device and the same backend, each in a new
  session of the test project:
  1. the `genui` bundle (Metro from the `genui` worktree), Rich answers on;
  2. a `dev` bundle (Metro from a checkout of `dev` without genui). The reply
     carries the same `openui` fence, which `dev` renders as a code block.
- Note the lowest JS FPS during each stream.
- Expected: the `genui` run's lowest JS FPS is at least 95% of the `dev`
  run's. Record both values and the device model. Prefer a low-end Android
  device.
- Optional second data point: the `genui` bundle with Rich answers off.

## Publishing the OTA

Do not run any of this without Jay's explicit approval.

### The process

The repository publishes OTA updates only through
`.github/workflows/mobile-ota.yml`, which runs
`node apps/mobile/scripts/ota-publish.mjs <channel> [--dry-run]`.
`rg -n "eas update" .github/workflows apps/mobile/package.json` finds no direct
`eas update` call: the script runs
`eas update --channel <channel> --platform <ios|android> --environment <env> --message <msg>`
per platform.

| Trigger | Channel | EAS environment | Code it ships | Reaches |
|---|---|---|---|---|
| `Deploy Prod` succeeded | `production` | `production` | the deployed `prod` commit | `prod-store`, `prod-apk` builds |
| manual, `channel=dev` | `dev` | `preview` | the ref the run starts from | `dev-store`, `dev-apk` builds |
| manual, `channel=production` | `production` | `production` | branch `prod`, whatever ref starts it | `prod-store`, `prod-apk` builds |

Commands:

```bash
# Dry run: checks every guard, publishes nothing.
gh workflow run mobile-ota.yml --repo kortix-ai/suna --ref dev -f channel=dev -f dry_run=true

# Publish to dev-backend builds (after genui is merged to dev and dev is deployed).
gh workflow run mobile-ota.yml --repo kortix-ai/suna --ref dev -f channel=dev

# Production: no manual step for new code. The next production release
# (Deploy Prod) publishes the released prod commit automatically.
```

Per platform the script skips when no finished build on the channel has the
current `runtimeVersion`, when the native fingerprint differs from the newest
build ("Rebuild required"), or when nothing under `apps/mobile`,
`packages/sdk`, or `pnpm-lock.yaml` changed. It fails when the environment's
`EXPO_PUBLIC_BACKEND_URL` does not answer `/health`. Rollback:
`apps/mobile/BUILD_GUIDE.md` → "Roll back a bad update".

### Runtime version and native modules

- Branch `genui` has `runtimeVersion` `1.5.0` in `apps/mobile/app.json`
  (Expo SDK 57), the same value as `dev` at its merge base `0e10275083`.
- The branch adds no native module. Its `apps/mobile/package.json` diff
  against the merge base (`git diff 0e10275083...genui --
  apps/mobile/package.json`) adds only:
  - `@openuidev/lang-core` `0.3.1` (dependency): JavaScript only; its one
    dependency is `ci-info`; no `ios/`, `android/`, podspec, or
    `expo-module.config.json`;
  - `zod` `3.25.76` (dependency): JavaScript only, no dependencies;
  - `maplibre-gl` `5.24.0` (devDependency): never bundled as a module; its
    script and stylesheet ship as `.webjs` assets.
- The native packages the branch uses already exist at the merge base:
  `react-native-webview` `13.16.1`, `react-native-svg` `15.15.4`,
  `expo-clipboard` `~57.0.2`. The `webjs` asset extension already exists in
  `apps/mobile/metro.config.js`.
- The branch changes nothing under `apps/mobile/ios`, `apps/mobile/android`,
  or `apps/mobile/patches`, and does not change `apps/mobile/app.json`.
- **Who gets the update:** it carries runtime `1.5.0` and reaches only
  `1.5.0` binaries. `1.4.4` binaries never receive it and keep the raw fence
  until the user installs a `1.5.0` store build.

### What the map adds to the update

Measured with `wc -c` on the committed files:

| File | Bytes |
|---|---|
| `apps/mobile/assets/maplibre/maplibre-gl.webjs` (MapLibre GL JS 5.24.0, per its license header) | 1,056,837 |
| `apps/mobile/assets/maplibre/maplibre-gl-css.webjs` | 70,024 |
| Total | 1,126,861 |

These are uncompressed sizes. The JS bundle growth from `lang-core`, `zod`,
and the genui components is not measured here.

### The map style on OTA builds

OTA and store builds read `EXPO_PUBLIC_*` values from the EAS environment
only (`apps/mobile/BUILD_GUIDE.md`). If `EXPO_PUBLIC_GENUI_MAP_STYLE_URL` is
not set in the `preview` or `production` EAS environment, updates show place
rows with OpenStreetMap links and no **Open map** row. Check with
`eas env:list production`. Setting it is a product decision (tile provider and
its terms); it is not part of this task.

### After publishing

Record in the PR: the update group ID from the run's notice
(`https://expo.dev/accounts/kortix/projects/kortix/updates/<group>`), the
runtime version, and the channel. Confirm with
`eas update:list --branch <channel> --limit 5`.

## Old-build check (spec R-MOB-1)

1. On a `1.5.0` build without the update (or with updates disabled), open
   the session from checklist step 1. A `1.4.4` build never receives the
   update, so it cannot do step 3.
2. Expected: the reply shows a code block with the OpenUI source. This is
   accepted (spec R-MOB-1).
3. Open the app, close it, and open it again with the update available. A
   device downloads the update on launch and runs it on the next launch.
4. Expected: the same reply now renders the two option cards.
