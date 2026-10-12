---
name: kortix-chrome
description: "Kortix for Chrome: the Chrome extension that connects a user's own browser to Kortix so a session's sandbox drives it over CDP (`kortix chrome use` + `agent-browser --cdp 9333`). Load WHENEVER you touch apps/chrome-extension, apps/api/src/chrome, the kortixd browser bridge, `kortix browser` CLI, the browsers settings tab or connect modal, the kortix-chrome managed skill, or when you build, load, test, publish or debug the extension."
---

# Kortix for Chrome

A user installs the **Kortix** Chrome extension and signs in. From then on, any
of their sessions can drive that browser, with its logins, from the cloud
sandbox. The agent runs `kortix chrome use`, then plain `agent-browser --cdp
9333 …` commands. The browser is a separate product from the agent tunnel
("Your computer"). It shares no code path, credential or UI with it.

The wire contract is [references/protocol.md](references/protocol.md). Read it
before you change any part. A wire change edits that file in the same commit.

## Where the code lives

| Part | Path |
|---|---|
| Extension (MV3) | `apps/chrome-extension` |
| API: control socket, REST, attach | `apps/api/src/chrome/` |
| Tables | `chrome_connections`, `chrome_grants`, `chrome_attachments` |
| Sandbox bridge + CDP endpoint | `apps/kortix-sandbox-agent-server/src/**/chrome*` |
| CLI | `apps/cli/src/commands/chrome.ts` |
| Agent skill (served to sessions) | `packages/starter/templates/managed/skills/kortix-chrome/SKILL.md` |
| SDK hooks | `packages/sdk/src/**/chrome*` (`useChromeConnections`, `useUpdateChromeConnection`, `useDeleteChromeConnection`) |
| Web | `apps/web/src/features/chrome/`, sidebar row `project-chrome-nav.tsx`, settings tab `chrome` (`/settings/chrome`) |

## How one action travels

1. The agent runs `kortix chrome use`. The CLI calls kortixd
   `POST /kortix/chrome/attach`.
2. kortixd mints a ticket and calls `POST /v1/chrome/attach` with the session
   credential.
3. The API picks the owner's browser, applies the access mode, and sends an
   `attach` frame down the extension's control socket. Another replica holds
   the socket? Then the frame goes through `pg_notify('kortix_chrome_cmd')`.
4. The extension asks for consent if needed. It opens a tab group
   `Kortix · <session title>` and dials the bridge through the existing preview
   proxy `/v1/p/<sandbox>/8000/kortix/chrome/bridge`.
5. kortixd serves the bridge as a CDP endpoint on `127.0.0.1:9333`. The
   extension's shim maps `Target.*` to `chrome.tabs` and forwards every page
   command to `chrome.debugger`.

The preview proxy is the rendezvous. It already pipes a long-lived WebSocket
from any API replica into the sandbox, so no replica owns the CDP stream.

## Build and load the extension

```bash
cd apps/chrome-extension
bun run build          # → dist/, ID gefbbnjgoiljpbnalgafbhbfdhikgjek (manifest key)
bun test               # shim + auth unit tests
bun run scripts/smoke.ts   # headless Chromium + real agent-browser through the shim
```

- Branded Google Chrome 137+ ignores `--load-extension`. Use Chrome for Testing
  or Chromium (`~/Library/Caches/ms-playwright/chromium-*/…`).
- Never run it headed on a shared Mac. `--headless=new` runs extensions.
- To load it by hand: `chrome://extensions` → Developer mode → Load unpacked →
  `apps/chrome-extension/dist`.
- Point it at another server: the welcome page → "Change" → API URL
  (`http://localhost:<api port>` for a worktree, `https://dev-api.kortix.com` for dev).

## Verify end to end

1. Start the worktree stack (`pnpm worktree start <slug>`), with the tunnel on,
   so cloud sandboxes reach the local API.
2. Load the built extension in a headless Chromium. Sign in through the real
   OAuth consent page on the local web app.
3. Start a real session. In the sandbox, run `kortix chrome use` and
   `agent-browser --cdp 9333 open https://example.com` then `snapshot -i`.
4. Assert:
   - the API row is online;
   - the attachment is `connected`;
   - the tab group exists with the session title;
   - the overlay host element is in the page;
   - Stop returns `chrome_denied` on the next `use`.

A sandbox runs the new kortixd and CLI only after the API serves them
(`/v1/runtime-assets`). They converge on boot and at turn end.

## Publish to the Chrome Web Store

The store rejects a manifest with `key` ("key field is not allowed in manifest").
`key` exists only so unpacked dev builds get the same ID.

1. `bun run build`, then copy `dist/` and delete `key` from the copy's `manifest.json`.
2. **First upload only:** add `key.pem` at the zip root. The store then assigns the ID
   `gefbbnjgoiljpbnalgafbhbfdhikgjek`, which the web app, API and docs link to. Get the key with
   `dotenvx get BROWSER_EXTENSION_KEY_PEM_B64 -f apps/api/.env | base64 -d > key.pem`
   (the Keychain also holds it under `kortix/BROWSER_EXTENSION_KEY_PEM_B64`).
3. Later uploads: the same zip without `key.pem`, with a higher `version` in `src/manifest.json`.
4. Listing text, permission justifications and data disclosures: keep them in step with
   the permissions in `src/manifest.json`. The "Add to Chrome" buttons link to
   `https://chromewebstore.google.com/detail/gefbbnjgoiljpbnalgafbhbfdhikgjek`.
5. The store fetches the Homepage and Support URLs before it allows a submit. A 404 blocks it
   ("Support URL is not reachable"). The listing uses `https://kortix.com/support`.
6. Submit only after prod serves `/v1/chrome/connections`. Reviewers sign in at kortix.com. Before that,
   the extension tells them "kortix.com does not have Kortix for Chrome yet".

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `chrome_offline` | Chrome closed, or the worker lost its socket | Open Chrome; the extension reconnects in 1–30 s |
| `chrome_denied` after Stop | Stop writes a deny grant for that session | The agent asks the user, then `kortix chrome use --ask` |
| `1011 No browser attached` on 9333 | No bridge for this sandbox | Run `kortix chrome use` first |
| `chrome_dial_failed` | The extension could not open the bridge (token, proxy, sandbox stopped) | Check the extension worker console and the API preview-proxy logs |
| Commands hang on a background tab screenshot | The tab is not painted | The shim activates the tab before `Page.captureScreenshot`; an occluded or minimized window can still stall |
