Reliable session starts, in-session connectors, and a native model picker

## Sessions start, resume, and stay honest

- The session loading screen no longer shows a false "Couldn't start session" card. A wake that stalls now escalates on its own — retry, then restart — with a cooldown ladder instead of a terminal state you had to clear by hand.
- The transcript loads instead of rendering empty while the sandbox boots, and it stays readable for stopped sessions. Transcripts are now mirrored server-side, so a session that is not running can still be read.
- The frontend no longer falls behind the agent or shows "stopped" while a turn is running. A running session no longer flips to stopped mid-turn.
- The prompt queue reflects delivery truth: a message is queued until the runtime accepts it, and a message the runtime cannot run is surfaced instead of silently dropped.
- Long turns no longer stop at random. Fixes cover provider deadline read-back, the request body cap, the OpenCode auto-updater (now off), a progress-aware boot budget, a bounded turn probe, and Bun's 300 s fetch idle timeout.
- Long sessions no longer run the sandbox out of memory: attachments are offloaded out of the transcript, a memory guard runs before the kernel does, and the reaper backs off its probes. Each sandbox exposes a daemon log and a `/kortix/diag` endpoint.
- Audit writes use a single upsert and a dedicated pool, so a lock convoy on the audit table can no longer surface as a "Bad Gateway" during a session.
- `/summarize` (compaction) no longer times out through the proxy; the compaction marker is minimal and the summary opens in the panel.
- A deleted session refuses `/start` and `/restart` with 404. Quota and provider races on project creation are gone. Rotated E2B ingress tokens refresh instead of failing.
- An untouched send skips a no-op scope round-trip, and the approval audit read drops to 100 rows — faster first send.
- OpenCode is bumped to 1.18.23 everywhere (fixes Bedrock redacted-content streams).

## Connect apps from the session (Composio)

- A new Connect Link flow replaces the connector overlay. Composio is the managed default provider; the agent selects it on its own.
- You can connect an app from inside the session without typing "done". A connect the human walked away from is finished later, and a stopped session is told when its connector landed.
- Gmail managed OAuth ships with the minimum scopes. The CLI and the intake link mint a Kortix connect link, never the provider's raw URL.
- The connector catalogue is sectioned and filterable at the source. A newly created connector keeps its detail view open.

## Models and the LLM gateway

- The LLM gateway is a per-project setting with a first-class native path when it is off: keys go to the sandbox environment and the native provider/model is used. It stays on by default.
- Native projects get a model picker before the sandbox runtime exists. The picker defaults to the latest flagship set; search reveals all. Deprecated models are hidden; models.dev status passes through.
- One capability source and one thinking knob for every model. The sandbox learns the project's servable model set at boot, so the picker never offers a model the runtime cannot run. The seed refreshes weekly.
- Bedrock: inference-profile ids are preferred, a refused bare id is retried with `global.`/`us.`, bare pins are healed, and no bare Bedrock id is used as a default. OpenAI-on-Bedrock reasoning effort now reaches the model. Summarized Bedrock reasoning streams. A rejected reasoning parameter gets one retry with per-model memory.
- Inline images are windowed inside the sandbox: every gateway session routes through the daemon LLM proxy.

## Approvals and permissions

- Approval and permission notices fill the composer strip. An approval you cannot decide is never rendered as decidable, an unreviewable card says what is true, an unauthorised reviewer is told so, and Approve is not offered on a row the server will reject.
- A truncated arguments preview no longer blocks approval.

## Web

- Inline "edit from here" editor with an honest Restore control.
- `bash`, `write`, and `edit` tool rows: zone layout, live counts, and a diff stat.
- Code blocks always show a copy button. The carousel tab no longer shifts the page sideways. One sidebar opener on every headerless session surface.
- Session previews stay loaded and both preview frames preload. An HTML file is served, never injected.
- Triggers keep access across stale reads. The setup-links modal finalizes when it closes.

## Change surfaces

- One vocabulary and one file list for every change surface.

## Under the hood

- CI moved to Blacksmith runners with tiered sizes, a kill switch, sticky-disk Docker cache, and a portable image-digest recipe. PR test lanes run natively.
- Secrets hygiene: prod dotenvx keys are owner-only, non-prod profiles carry no prod-reaching credential, and a separation tripwire enforces it.
- The release pipeline refuses a version tag collision.
