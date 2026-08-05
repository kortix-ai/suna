Sandbox hardening, faster navigation, and honest sessions

**New**

- One-shot approval links: approve or reject an agent's pending request straight from the notification link, without opening the app.
- Sandboxes now ship with a baked-in Python package floor — Pillow, pypdfium2, pytesseract, and 13 more pinned packages — so document and image skills run immediately, with no install step.
- The session header warns when an agent's configuration changed on disk after the session started, with a one-click reload that updates the files the agent actually reads.
- Terms of Service are linked from /legal/terms.

**Improved**

- Project page navigation is noticeably faster, and the web app moved to Next.js 16.2.0.
- Messages queued while the agent is working now stay queued until the turn actually ends — no more mid-turn releases or duplicate sends.
- One keyboard shortcut (⌘I / Ctrl+I) now toggles the whole right side of a session: the action panel, a detail panel, or both.
- Session error states are clearer: tool failures are reported truthfully, retry states show what is happening, and a stale agent config no longer needs a page reload to surface.
- The CLI is quieter and more honest: `--quiet` is honoured on every path, and it no longer claims an invite email was sent when none was.

**Fixed**

- Hardened the sandbox: closed a proxy hole that could leak the sandbox service key to an attacker-named host, closed a DNS-rebind window by connecting only to the address that was vetted, resolved symlinks before authorizing file paths, and stopped one session's credentials from being served to other members of the account.
- Secrets: setup links now expire on time, re-scoped secrets validate against the session owner rather than the caller, and secret identifiers are no longer disclosed through the narrowing report.
- Session reliability: removed two paths that could silently destroy a session's commits, a planned restart now finishes the turn it interrupts, a failed agent spawn schedules a respawn instead of killing the session, and reloading an agent never hard-resets the session branch.
- A transient git failure can no longer compile an agent with an empty prompt.
- Queued API errors: address-validation failures now return a proper 400 instead of a server error.
