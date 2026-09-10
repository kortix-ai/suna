# Desktop UI verification

The desktop app loads the same frontend as web. Product fixes belong in shared
components. Native exceptions cover window controls, dragging, and native APIs.

## Run the regression journey

Use the canonical worktree. The root runner reads `.kortix-worktree.json` and
starts its deterministic stack. Do not replace another worktree's development
server. Install the Electron runtime once with
`pnpm --filter @kortix/desktop-electron run setup`.

```sh
E2E_GREP='27 — desktop parity' pnpm test -- --browser-only
E2E_DESKTOP_NATIVE=1 E2E_GREP='27 — desktop parity' pnpm test -- --browser-only
```

The first command runs paired web and desktop-user-agent journeys in Chromium.
It runs in the normal browser CI lane and against preview origins. The second launches this
branch's Electron app with a temporary profile. It uses the same user, project,
controls, and assertions. It requires a graphical desktop. It does not use or
change the user's signed-in profile.

The journey covers the workspace selector, settings navigation, agent section
navigation, and connector filters. It asserts rendered row geometry, titlebar
clearance, selected state, route changes, and a successful connector request.
Native mode checks zoom, full document navigation, and rejection of native
commands from a second window. The configured frontend origin owns the native
bridge; embedded content and other windows must not inherit that permission.
Screenshots and failures appear under `tests/test-results/artifacts`.
Electron unit tests run in the existing packages lane through
`pnpm --filter @kortix/desktop-electron test`.

## Verify the changed surface

- Click every changed control and check its route or request plus visible result.
- Open and close the sidebar. Repeat navigation with the sidebar collapsed.
- Open fullscreen settings. Verify Back to app and the final navigation row.
- Check light and dark themes at 1440 × 900 and 720 × 480 window sizes.
- Check default zoom, zoom in, zoom out, and reset. Native controls do not zoom.
- Use Tab, arrows, Enter, and Escape. Focus must remain visible and reachable.
- Scroll long lists. Check empty, loading, error, and disabled states where relevant.
- Repeat on the PR preview with Electron's Frontend URL set to the preview origin.

### Instance chooser (first launch, Custom URL…, load failure)

The native journey sets `KORTIX_DESKTOP_URL`, which skips the chooser. Check it
by hand on an empty profile without that variable:

```sh
KORTIX_DESKTOP_USER_DATA="$(mktemp -d)" pnpm --filter @kortix/desktop-electron exec electron .
```

- The chooser opens before any page loads. Quit, relaunch on the same profile:
  it opens again.
- Kortix Cloud loads the baked default. No `frontend_url` file exists after.
- Self-hosted with a reachable URL saves `frontend_url` and loads it. An
  unreachable URL shows the error and **Continue Anyway**.
- Relaunch on the same profile: no chooser.
- Point `frontend_url` at a dead port and relaunch: **Can't reach \<host\>**
  opens over the window. **Try Again** and **Quit** work.
- A profile from an older build (non-empty, no `instance_setup_pending`) never
  shows the chooser.

Browser automation does not replace a native visual check of the traffic lights
or OS dragging. Verify them in Electron. After an explicitly approved merge,
verify the deployed SHA and repeat the affected interaction against dev.

## Keep one owner

`apps/desktop-electron/src/window-chrome.js` owns native traffic-light geometry.
The CSS variables in `apps/web/src/app/globals.css` mirror it. The focused
`desktop-titlebar.test.ts` tests keep these values synchronized.

`.kx-titlebar-tabs` marks only the top capability bar. Product tab lists keep
the shared Tabs component's layout. `.kx-titlebar-spacer` reserves native chrome
for fullscreen overlays. It cannot shrink inside a flex column.

Do not inject layout CSS from Electron. Do not mark all `[role="tablist"]` or
`[data-sidebar="sidebar"]` elements as window drag regions. Reserve dragging for
explicit shell chrome and keep interactive elements outside those regions.

## Record the result

Record branch, SHA, commands, pass/fail counts, runtime, OS, viewport, zoom,
screenshots, preview origin, and any unverified path. Mark local, preview, and
deployed verification separately. A passing web run does not imply desktop passed.
