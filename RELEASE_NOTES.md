Sandbox reliability fixes, per-project provider override, and gateway logging fix

### New
- **Per-project sandbox provider override** — pin a project to a specific sandbox provider (e.g. Platinum) from Customize → Settings, instead of always following the platform's weighted default.

### Fixed
- Sandboxes could fail on literally the first message in a silent retry loop, caused by a broken dependency bundle baked into the sandbox image. Sandbox image builds now verify the bundle actually works before shipping.
- A new session's first prompt could be silently dropped right after sandbox startup, requiring a resend. The app now waits for the sandbox to finish restarting before sending the prompt.
- Fixed a Postgres error that could interrupt request logging when an LLM request or response contained certain binary characters.
- Fixed a migration bug that could strand a retry in a failed state instead of resuming cleanly.
- Fixed an edge case in account membership repair.
- Improved error handling when an AgentMail inbox hits its limit.

### Internal
- Restored the full staging release-verification pipeline (Vercel authentication bypass) after a temporary gate exclusion.
- Removed the manual prod-hotfix workflow — all production changes now go through the standard promotion flow.
