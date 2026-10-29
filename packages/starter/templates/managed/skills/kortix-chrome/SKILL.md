---
name: kortix-chrome
description: Drive the USER'S OWN Chrome (their real logged-in session) from a Kortix session, over CDP, through the Kortix Chrome extension. Load this when the task needs the user's logins or real browser state ("my browser", "my Chrome", "while I'm logged in", "check my inbox / dashboard / account", a site that needs the user's login, 2FA or cookies), or when a site blocks or captchas the sandbox's cloud browser. For public pages and anything that needs no login, use the sandbox browser (the `agent-browser` skill) instead.
metadata:
  kortix-feature-flag: chrome
---

<skill name="kortix-chrome">

<overview>
The user installs the Kortix extension in Chrome once. `kortix chrome use`
then attaches that Chrome to this session, and `agent-browser` drives it
through a CDP endpoint on `127.0.0.1:9333`. It is the user's real chrome:
their cookies, logins and extensions.

Use the sandbox browser (`agent-browser` with no `--cdp`) when no login is
needed. Use the user's browser when the user says "my browser" or "my Chrome",
or the task needs their logged-in state.
</overview>

<flow>
1. `kortix chrome use` (add a name if the user has several: `kortix chrome use Work`).
   Success prints `✓ Using Chrome · Work (macOS)`.
2. Drive it with the usual commands plus `--cdp 9333`:
   `agent-browser --cdp 9333 open https://example.com`
   `agent-browser --cdp 9333 snapshot`
   `agent-browser --cdp 9333 click @e3`
   Load `agent-browser skills get core` for the command set.
3. `kortix chrome release` when the task is done. Always release.

`kortix chrome status` shows whether a browser is attached. `kortix chrome ls`
lists the user's browsers.
</flow>

<what_the_user_sees>
Your tabs open in a group named after this session (in browsers that have tab
groups), with a glow around them and a control bar with **Take over** and
**Stop**. The user may pause you (Take over) or end your access to the browser
(Stop) at any time. Input commands fail while they have control; wait and retry.

The user picks the access mode in the extension or in Kortix settings: *without
asking*, *ask first* (your first `use` shows a prompt in Chrome and waits up to
90 seconds), or *off*.
</what_the_user_sees>

<tabs>
`kortix chrome use` prints the tab scope the user chose.

- **All tabs** (the default): `agent-browser --cdp 9333 tab list` lists every tab
  in every window. Answer questions about what the user has open from that list.
  You start in a tab of your own; work there with `open` and `tab new`. Switch
  to one of the user's tabs (`tab <id>`) only to read it or when the user asks
  you to act in it, and never navigate a tab of theirs away from its page.
- **Only tabs it opens**: you see your own tabs and nothing else. If the user
  asks about their other tabs, say so in one line and tell them where to change
  it: the Kortix extension popup → Tabs → All tabs, or Settings → Chrome
  extension in Kortix. Then run `kortix chrome use` again.
</tabs>


<working_well>
- Every command crosses the internet to the user's machine (about 0.3 s each).
  Chain related commands in one shell call, and re-snapshot only after the page
  changed.
- Page dialogs: after a click that opens `confirm()`/`prompt()`, answer it with
  `agent-browser --cdp 9333 dialog accept` (or `dismiss`). If a command is stuck
  on a dialog for a second, the extension answers OK so nothing deadlocks.
- Uploads work from the sandbox: `agent-browser --cdp 9333 upload <selector>
  /path/in/sandbox` (up to 10 MB in total). Downloads land in the user's
  Downloads folder on their machine, not in the sandbox.
- Elements without an accessible role (drag targets, plain `div`s) have no `@ref`:
  use a CSS selector (`drag "#column-a" "#column-b"`).
- `check`/`uncheck` only on checkboxes; confirm with `is checked`. The last tab
  cannot be closed (`Cannot close the last tab` is harmless).
</working_well>

<errors>
- **No browser connected** (`chrome_not_connected`, `chrome_offline`): the CLI
  prints a connect link. Send the user ONE line, for example: "I need your
  Chrome for this. Install the Kortix extension here: <link>. Tell me when it
  shows Connected." Then wait. Do not fall back to the sandbox browser for a task
  that needs their login.
- **Denied or stopped** (`chrome_denied`): the user said no, or pressed Stop. Do
  not retry on your own. Ask the user. If they agree, run `kortix chrome use --ask`.
- **Access off** (`chrome_access_off`): tell the user to switch the browser to
  "Without asking" or "Ask first" in Kortix settings (Settings → Kortix in Chrome), then wait.
- **Timeout** (`chrome_consent_timeout`): nobody answered the prompt in Chrome.
  Tell the user to look at Chrome, then run `kortix chrome use --ask` again.
- **`chrome_dial_failed`**: Chrome did not connect. Ask the user to check that
  Chrome is open and the extension is signed in.
- **agent-browser cannot reach `127.0.0.1:9333`** (`No browser attached`,
  `Auto-launch failed … No webSocketDebuggerUrl`): no browser is attached. It was
  released, the user pressed Stop, or Chrome closed. Run `kortix chrome use`;
  after a Stop it answers `chrome_denied`, so ask the user first.
- **`kortix chrome` is unknown, or `/kortix/chrome/*` answers 404**: this sandbox
  still runs an older Kortix runtime. It updates itself when the turn ends. Tell
  the user in one line to send the request again, then stop. Do not inspect or
  restart the daemon.
</errors>

<rules>
- Act only on what the task needs. This is the user's real account: never send,
  buy, delete or post unless the user asked for that exact action.
- Do not read or copy cookies, tokens or passwords out of the browser.
- Release the browser when you finish, and before you ask the user a question
  that will take a while.
- `chrome://` pages, the Web Store and extension pages are out of reach.
- If an `agent-browser` command fails twice with the same CDP error, stop. Do not
  write scripts to probe the CDP endpoint. Run `kortix chrome release`, then
  `kortix chrome use` once; if it still fails, tell the user the exact error in
  one line and ask them to reload the Kortix extension.
</rules>

</skill>
