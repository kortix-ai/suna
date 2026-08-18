Apps goes stable, Monitors lands experimental, and a big session-reliability pass

## New

- **Apps is now a stable feature** — it moved out of experimental status and sits in the sidebar under Customize. Apps open instantly (no more loading flash), show their desktop layout on the preview card instead of mobile, and get their own IAM permissions and per-team scoping. Non-public Apps are now usable and honest about who can access them; self-host installs can serve Apps even though they can't publish to kortix.com.
- **Invite-time project grants** — inviting someone to a project now grants both the account role and project access in one step, instead of two separate actions.
- **Settings unified into one tabbed panel**, and the Billing pane was rebuilt with fewer boxes and a single credits card.
- **Chat input rebuilt** to stop duplicate and lost sends; triple-tapping Escape now stops the agent even while you're typing.
- **Easy panel overhaul** (the non-technical-user view): memory updates are now visible and plainly labelled, skill and task calls expand with live sub-agent activity, and a connect-apps strip and context-card actions were added.
- **Session usage modal** reworked for clarity and speed; the model switcher and session usage view now show the real upstream provider instead of "Kortix".
- **Monitors** (experimental): a new trigger type that runs on its own provisioned box, with its own CLI command group and MCP surface.
- **Network-boundary secrets on Daytona**: an in-guest egress shim scopes a secret to the sandbox it was issued to, replacing the old operator-wide env var.
- **Presentations framework** at `/presentations`, including a diagram-led security deck.
- Added managed models: DeepSeek V4 Pro 0813 and Grok 4.6.
- The CLI now shows the identity behind a minted agent token instead of reporting "not logged in".

## Fixed

- A cluster of stuck-session bugs: sessions could get wedged on boot with no retry, get stuck in a runaway self-repeating turn, show phantom interrupts, or strand mid-workspace-switch. A failed direct send now lands in the failed lane instead of disappearing, and prompts no longer get lost around session hand-off.
- Session truth now reads from a durable server-side turn ledger over HTTP, replacing several client-side guesses about whether a session is still working.
- Self-host: Storage now hands out public URLs instead of an internal Docker host address, and updates auto-heal from unlogged-table fork corruption that used to block them.
- The gateway reports what an LLM request actually cost, not what Kortix billed; it no longer kills slow reasoning turns at a hard 90-second timeout, drops the trailing-assistant prefill that made strict backends fail, and its body size ceiling is raised to 1 GiB (was rejecting large multimodal requests).
- MCP catalog discovery is now authenticated, and private sessions are no longer discoverable by other connectors.
- Creating a duplicate App slug now returns 409 instead of 500.
- The Vercel production frontend build now pins its runtime version so it can't get stranded on a stale one.
- Cleaned up frontend error noise from bot/automation scripts and third-party scripts on Safari.
- The reasoning-effort icon for Auto is now visually distinct, and agent names are capitalized consistently.

## Notes

This release also includes a large internal hardening pass: an in-guest network-boundary/egress-secrets system, a warm-session simplification (session pooling now reuses ordinary sessions instead of a separate warm-session concept), a large API route-file split for maintainability, and expanded test coverage across sessions, monitors, and the deployed staging gate.
