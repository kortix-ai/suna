# Mobile device check and OTA hand-off (plan 5, task 7)

This file is the on-device checklist for generative UI on mobile, and the
procedure to publish it as an EAS Update. Jay runs it on a real device. No
simulator is used. The agent publishes nothing: an OTA publish reaches every
installed app on the channel and needs Jay's explicit approval.

## Preconditions

1. The backend the app talks to runs the genui runtime. It is on `dev`, and
   generative UI has no flag: every session lists the `kortix-genui` system
   skill. To test unmerged changes, point the app at a worktree's local stack
   (`pnpm worktree start <slug>`, then set `EXPO_PUBLIC_BACKEND_URL` to an
   address the phone can reach, for example the cloudflared tunnel URL plus
   `/v1`).
2. Use a session that started on a sandbox image with the current skill. A
   running, restarted or warm session keeps the skill text it booted with.
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

### 2. Bar chart: source title, legend, y axis, Show data

- Prompt: `Show me revenue by quarter: Q1 1200, Q2 1500, Q3 1700.`
- Expected: a chart card. The header row shows the source as the title on
  the left (no `Source:` prefix) and **Show data** on the right. Under it, a
  legend with one entry, the series name (for example `Revenue`). A chart
  with 2 or more series has one legend entry per series.
- The plot has three bars (Q1, Q2, Q3) and a y axis on the left with round
  ticks in compact form: `0`, `500`, `1K`, `1.5K`, `2K`, with one grid line
  per tick. There is no separate max label. A tick that reads `1,000`,
  `1000`, or `1,500` is a fail: Hermes then lacks compact number format.
- Tap **Show data**: a bottom sheet titled **Show data** opens. It shows the
  source line and a table with the same three values (`1,200`, `1,500`,
  `1,700`). Swipe the sheet down: it closes.

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

### 5. Map off, then the inline map

Prompt for both runs:
`Show the delivery route on a map. Stops in order: Depot 51.5074, -0.1278; Stop A 51.5155, -0.0922; Stop B 51.5033, -0.1196; Stop C 51.4975, -0.1357.`

`EXPO_PUBLIC_GENUI_MAP_STYLE_URL` selects the basemap (`apps/mobile/lib/genui/map-style.ts`):
`off` draws no map, empty or unset uses OpenFreeMap, and any other value is the style URL.

a. Set `EXPO_PUBLIC_GENUI_MAP_STYLE_URL="off"` in `apps/mobile/.env`, restart
   Metro with `pnpm dev`, and send the prompt in a new session:
   - Expected: no map. One row per stop. Each row shows the name, the
     description as a muted line under it when the model gave one, and a row
     of buttons: **Directions**, then **Website** and **Call** when the stop
     has a website or a phone. A row has no pin icon, and a tap on the row
     itself does nothing.
   - Tap **Directions**: Google Maps opens directions to that stop.

b. Remove the line from `.env` (the OpenFreeMap default), or set an explicit
   style such as
   `EXPO_PUBLIC_GENUI_MAP_STYLE_URL="https://tiles.openfreemap.org/styles/liberty"`.
   Restart Metro with `pnpm dev` and send the prompt in a new session:
   - Expected: while the fence streams, the block holds the loading block.
     Then an inline map, 320 pt tall, shows in the transcript with four pins
     and the route line (when the model includes a route). The inline map is
     still: it has no zoom buttons and no popups.
   - Scroll the transcript up and down over the map: the transcript
     scrolls. The map does not move.
   - Tap the map: a full-screen dialog opens with the interactive map. The
     attribution control is the compact one: an `i` button that expands to
     the attribution text. Pan and pinch move only the map.
   - Tap a pin: its popup is the place card: the photo when there is one,
     the name, `value · kind` when the place has them, the description, then
     **Directions**, **Website**, and **Call** (the last two only when the
     place has them).
   - Expand the attribution if it is collapsed, then tap its
     `OpenStreetMap` link: the browser opens the link and the app stays on
     the dialog. Close the dialog.
   - A style that cannot load is step 17.

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

- Repeat steps 1, 2, and 5 in light and in dark theme. In step 5b, the
  default basemap follows the theme: OpenFreeMap `positron` in light,
  `dark` in dark. An explicit style URL is the same in both themes. The pins,
  the popup card, and the place rows take the theme's surface and ink.
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

### Web parity steps (branch `feat/genui/mobile-parity`)

Steps 11 to 18 cover branch `feat/genui/mobile-parity`. Run them on a bundle
from that branch's worktree. The mobile OTA with this branch must ship
before a `kortix-genui` skill revision relies on these behaviors (genui
`SKILL.md` rule 12). Compare each block with the same block on web when you
can: web is the reference.

### 11. Single card: rating, reviews, price

- Prompt: `Show one hotel as a card: Harbor View Hotel, a quiet hotel by the old port, rating 4.6 from 1240 reviews, from 150 EUR a night, with a photo.`
- Expected: one card. Under the title, one line reads star, rating, review
  count in parentheses, a `·` separator, then the price (for example
  `★ 4.6 (1,240) · From 150 EUR a night`). The star and the rating are ink.
  The review count is muted. The photo covers its box with no outline.

### 12. Card list: badges top right, gold star on the pick

- Prompt: `Compare three hotels as a list of cards: Hotel North 4.5 stars, 120 EUR, badge "Best value" (good); Hotel South 4.2 stars, 95 EUR, badge "2 rooms left" (warn); Hotel East 4.8 stars, 180 EUR, badge "Sea view".`
- Expected: three rows, each with a photo or no photo on the left. Each
  row's badges sit on the title row, at the top right. Every badge is the
  same neutral grey pill, whatever its tone: the secondary surface at 80%
  with secondary-foreground text. Only the `good` badge (`Best value`) leads
  with a gold star. The other badges have no star and no tone color. A
  thumbnail that fails to load leaves no empty box.

### 13. Bar chart with a negative value

- Prompt: `Show monthly profit as a bar chart: Jan 40, Feb -25, Mar 10, Apr -5.`
- Expected: Jan and Mar rise above the zero line. Feb and Apr hang below
  it. The y axis shows the ticks `-40`, `-20`, `0`, `20`, `40`, with one
  grid line per tick. No bar clips at the top or the bottom of the plot.
- Compact labels: step 2 checks a value of 1,000 or more (`1K`, `1.5K`).

### 14. Legend tap focus

- Prompt: `Show a line chart of weekly signups for two products: Product A 10, 14, 18, 22; Product B 8, 9, 15, 12. Weeks W1 to W4.`
- Expected: a legend with two entries. Tap `Product A`: Product B's line dims
  to about 15% opacity, Product A stays full. Tap `Product A` again: both
  lines are full. Repeat on a bar chart (step 13 or step 2 with two series)
  and on a pie (step 15): a tap on a legend entry dims the other slices.

### 15. Empty pie shows the loading block, then fills

- Prompt: `Show my budget split as a pie chart: Rent 1200, Food 400, Transport 150, Savings 300.`
- Expected: while the reply streams and the pie has no slices yet, the block
  shows the loading block (spinner only) at the pie's settled height. When
  the slices arrive, the pie draws in the same space. The transcript under
  the block does not jump.

### 16. Map pin popup: Directions, Website, Call

- `EXPO_PUBLIC_GENUI_MAP_STYLE_URL` unset or a working style (the default is
  OpenFreeMap).
- Prompt: `Show two cafes on a map with their phone and website: Cafe Alpha at 48.8566, 2.3522, phone +33 1 00 00 00 01, website https://example.com/alpha; Cafe Beta at 48.8606, 2.3376, phone +33 1 00 00 00 02, website https://example.com/beta.`
- Expected: while the fence streams, the block holds the loading block. Then
  a still map shows with both pins. Scroll the transcript over it: the
  transcript scrolls. Tap the map: the full-screen map opens. Tap a pin: its
  popup is a place card with **Directions**, **Website**, and **Call**.
  **Directions** opens Google Maps directions to that place. **Website** opens the
  place's `https` link. **Call** opens the phone dialer with that number. A
  place with no phone has no **Call**. A website that is not `http(s)` has
  no **Website**.

### 17. Broken map style falls back to the place list

- Set `EXPO_PUBLIC_GENUI_MAP_STYLE_URL="https://example.invalid/style.json"`
  in `apps/mobile/.env` and restart Metro with `pnpm dev`.
- Send the step 16 prompt in a new session.
- Expected: within 10 s after the block settles, the map area turns into the
  place list: one row per cafe with **Directions**, **Website**, and
  **Call**. The block does not stay blank and the app does not crash.
- Set the value to `off`, restart Metro, and send the prompt again: the
  place list shows at once, with no map.
- Remove the line from `.env` and restart Metro after the check.

### 18. A block that fails does not blank the message

- A real prompt cannot force a component to throw. This step is covered by
  tests only: `apps/mobile/components/genui/genui-message-block.test.tsx`
  (the block's own error boundary). The GenUI debug screen
  (`GenuiDebugScreen`, `kortix://genui-debug`) does not cover it: it renders
  `GenuiBlock` directly, without the message block's boundary.
- On device, check the related path: open the debug screen (project home →
  **Debug GenUI** in a dev build) and scroll to `Invalid block (BROKEN_TABS)`.
  Expected: the invalid block shows its issues count and the other samples
  on the screen still render.
- Expected (tests): a component that throws inside the SDK falls back to
  its markdown. A throw the SDK cannot contain shows *This content could not
  be displayed.* in place of that block only. The sibling block and the
  message text still render.

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
5. A build that already renders genui but predates Steps and Checklist (its bundled
   SDK has no Steps spec) shows *This content could not be displayed.* in place of
   a Steps or Checklist block. It does not show their markdown: the parser drops an
   unknown component (`unknown-component`, `no-root`). Send this OTA, and publish
   the CLI on the same SDK, before the regenerated `kortix-genui` skill reaches
   sandboxes (genui `SKILL.md` rule 12).
