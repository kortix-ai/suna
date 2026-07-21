# ACP v1 conformance audit

Read-only audit of the ACP-native runtime (`acp-harness-runtime-v2`, PR #4510) against the [Agent Client Protocol v1 spec](https://agentclientprotocol.com/protocol/v1/overview). Method: crawled all 19 v1 spec pages plus the v2 draft, the RFD/announcement stabilization history, and `protocol/v1/schema.md` (via WebFetch, `.md` raw variant); read the bridge (`apps/kortix-sandbox-agent-server/src/acp/**`), the SDK (`packages/sdk/src/acp/**`, `packages/sdk/src/react/use-runtime-sessions/**`), and the web composer (`apps/web/src/features/session/**`); cross-checked every claim against **9,923 real captured JSON-RPC envelopes** in `kortix.acp_session_envelopes` (local Postgres, readonly) spanning all four harnesses (Claude Code, Codex, OpenCode, Pi) and 164 distinct runtime sessions.

Audited at HEAD with five writer agents concurrently active in the worktree. One in-flight, uncommitted diff is relevant and called out inline: `apps/api/src/projects/lib/acp-envelope.ts` is mid-edit, adding `extractHarnessSessionTitle`/`extractFallbackTitleFromPrompt` — a live example of `session_info_update` being extended right now, corroborating this audit's Part 1 finding on that notification rather than contradicting it.

---

## Part 0 — the version question

**Verdict: "We use v1, right?" — yes, correctly, on the wire.** `protocolVersion: 1` is what `@kortix/sdk` sends in every real captured `initialize` request (`session.ts:608`, `packages/api/src/projects/session-lifecycle/engine.ts:670`), and it's the value every adapter echoes back (`@agentclientprotocol/claude-agent-acp@0.58.1`, `@agentclientprotocol/codex-acp@1.1.2`, `pi-acp@0.0.31`, OpenCode's native ACP) — confirmed in 253 real `initialize` round-trips, 100% `protocolVersion: 1` both directions. This is not half-wrong.

**But the framing "v1 vs v2" is the wrong lens**, and this needs correcting in the owner's mental model:

- **v1 is a living, additively-versioned spec.** Per `protocol/v1/initialization.md`: *"This version is only incremented when breaking changes are introduced"* and *"the introduction of new capabilities is not considered a breaking change."* Since v1 shipped, a stream of RFDs has stabilized straight into the v1 doc tree without any version bump: `session_info_update` (stabilized Mar 9 2026), `session/list` (Mar 9), `session/resume` (Apr 22), `session/close` (Apr 23), `additionalDirectories` (Jun 1), `session/delete` + `session/usage`/`usage_update` + `messageId` (all Jun 5), `model_config` category (Jun 24), `$/cancel_request` generic cancellation (Jun 29), `logout` (May 21), boolean config options (Jul 6 — two weeks before this audit). **All of these are v1-stable**, gated only by capability flags at `initialize`, not by protocol version.
- **v2 is a separate, currently-Draft rewrite**, published as a draft announcement on **2026-07-20** — two days before this audit. Per `announcements/acp-v2-draft.md`: *"ACP v2 is a Draft... implementers should support both versions side by side."* It is not released, and nothing in this codebase should be targeting it yet.
- So: `session_info_update`, `session/set_config_option`, `config_option_update`, `usage_update` — all real, all confirmed live in the captured envelopes — are **v1-stable features, not v2 leakage and not unstable extensions**. The internal doc that cited v2 pages for `session-config-options` was citing the wrong tree (v1 has its own `protocol/v1/session-config-options.md`, stabilized independently), but the *feature itself* is correctly used under v1.
- The real gap is not version-mixing. **It's that the SDK correctly negotiates a rich, current v1 capability set at `initialize` (`loadSession`, `sessionCapabilities.{list,close,delete,resume,additionalDirectories,fork}`, `mcpCapabilities`, `promptCapabilities`, `auth.logout`) and then never reads that negotiation result for anything.** `grep -rn "\.capabilities\b"` across `apps/web/src/features/session` returns zero hits. The capability object is stored on `AcpSessionSnapshot.capabilities` (`session.ts:667`) and consumed by nothing. Every optional-feature decision downstream (image-attachment gating, `session/load` vs `session/resume`, mode switching, logout, slash commands) is hardcoded rather than capability-driven. This is the throughline behind most of Part 1/2's findings below.

---

## Part 1 — the matrix

Legend: **CORRECT** (implements the spec item as documented) · **INCOMPLETE** (partially implemented, gaps noted) · **INCORRECT** (implemented but violates the spec) · **MISSING** (spec item, nothing implements it) · **N/A** (justified non-applicability, architecture-driven).

### Initialization — [`protocol/v1/initialization.md`](https://agentclientprotocol.com/protocol/v1/initialization)

| Spec item | Where | Status |
|---|---|---|
| `initialize` round-trip (`protocolVersion`, `clientInfo`, `clientCapabilities`) | `packages/sdk/src/acp/client.ts:98-104`, `session.ts:607-611` | **CORRECT** — verified against 253 real round-trips, `protocolVersion:1` both ways |
| `clientCapabilities.fs.{readTextFile,writeTextFile}` | never set `true` anywhere (`grep -rn clientCapabilities` across web/sdk/api/bridge) — always `{}` or `{auth:{_meta:{gateway:true}}}` | **N/A** — justified: harness processes run co-located inside the sandbox with direct filesystem access; there is no remote-client fs boundary for the harness to proxy through. Self-consistent: 0 of 9,923 envelopes contain `fs/read_text_file`/`fs/write_text_file`, on either side |
| `clientCapabilities.terminal` | same as above, never `true` | **N/A** — same justification; 0 `terminal/*` envelopes observed |
| `clientCapabilities.session.configOptions.boolean` | never set | **CORRECT** — conservative default; consistent with 0 harnesses ever sending a `type:"boolean"` config option (all observed `config_option_update`s are `type:"select"`) |
| `agentCapabilities` negotiation result consumed by client behavior | `session.ts:667` stores it; **zero** reads anywhere in `apps/web/src` | **INCOMPLETE** — negotiation happens, result is inert (see Part 0) |
| `authMethods` array | stored on snapshot (`session.ts:669`); real captured values include `api-key`, `chat-gpt`, `gateway`, `gateway-bedrock`, `pi_terminal_login`, `opencode-login` | **INCOMPLETE** — captured, not surfaced or acted on (see `authenticate` below) |
| Baseline content support (`text`, `resource_link`) | `packages/sdk/src/acp/content.ts` | **CORRECT** |

### Authentication — [`protocol/v1/authentication.md`](https://agentclientprotocol.com/protocol/v1/authentication)

| Spec item | Where | Status |
|---|---|---|
| `authenticate` method | **not implemented** — `AcpClient` (`client.ts`) exposes `initialize`/`newSession`/`loadSession`/`setSessionConfigOption`/`prompt`/`cancel`/`respond`/`notify` and nothing else | **MISSING**, but architecturally mitigated: credentials are injected at process-launch time via env vars (`harness-registry.ts`'s elaborate per-harness `resolveAcpHarnessLaunchEnv`), not negotiated over the ACP wire. Real gap: mid-session credential expiry (e.g. an expired Codex subscription token) has **no ACP-level recovery path** — only killing and relaunching the whole harness process. This is a plausible root cause for stuck/failed sessions on token expiry that never surfaces as an actionable "reconnect your account" prompt |
| `logout` | never called (`grep -rn "'logout'"` across sdk/web finds nothing ACP-related); Codex advertises `agentCapabilities.auth.logout:{}` in real captures | **MISSING** — low severity, no user-facing "disconnect provider" action routes through ACP |
| `auth_required` error surfacing (implied by `-32000`) | no code branches on this specific error code anywhere in `apps/web/src/features/session` | **INCOMPLETE** |

### Session setup — [`protocol/v1/session-setup.md`](https://agentclientprotocol.com/protocol/v1/session-setup)

| Spec item | Where | Status |
|---|---|---|
| `session/new` | `client.ts:106-111` | **CORRECT** |
| `session/load` (must replay conversation) | `client.ts:113-118`; replay-suppression logic in `load-replay.ts` + `reduce.ts`'s `openSessionLoadOrdinals`/content-identity walk | **CORRECT** for what it does — well-tested (per-harness replay-shape handling: Claude same-id re-walk, Codex new-id consolidated chunk, Pi id-less complete message; see `reduce.ts:399-447`) |
| `session/resume` (no-replay reconnect) | **not implemented** — no method on `AcpClient` | **MISSING-FEATURE**, real cost: `session/resume` is advertised by 3 of 4 harnesses in real captures (Claude: `resume:{}`; Codex: `resume:{}`; OpenCode: `resume:{}`; Pi: only `list:{}`), but the SDK *always* uses `session/load` — meaning every reconnect/reload pays the full conversation-replay cost even when the spec's cheaper, purpose-built path is available and advertised. Plausible perf/latency contributor on long-running sessions after a page reload |
| `session/close` | never called; sessions are torn down via `AcpProcess.stop()` → SIGTERM/SIGKILL of the whole child process (`runtime.ts:252-269`) | **N/A** — justified: one harness process per session (never shared), so there's no "free resources without killing the process" case to serve |
| `additionalDirectories` | never populated — `session/new`/`session/load` always omit it | **MISSING-FEATURE** — low severity today (single-`/workspace`-root sandbox model), but the capability is advertised by Claude/Codex in real captures and there's currently no way to grant a harness a second workspace root even if product needs one later |
| `mcpServers` param | **always sent as `[]`**, every call site (`session.ts:621,635,638`; `engine.ts:676,678`; `kortix.ts:773,776`) | **MISSING-FEATURE — flag prominently.** ACP's first-class mechanism for handing a harness MCP servers (stdio/http/sse) at session start is wired end-to-end and unconditionally empty. If any Kortix MCP/connector surface is meant to be exposed *to* these coding-agent harnesses via ACP, this is the spec-native path for it and it is currently a no-op |

### Prompt turn — [`protocol/v1/prompt-turn.md`](https://agentclientprotocol.com/protocol/v1/prompt-turn)

| Spec item | Where | Status |
|---|---|---|
| `session/prompt` | `client.ts:124-126` | **CORRECT** |
| `stopReason` in the `session/prompt` response | fetched (`client.prompt()` resolves `{stopReason}`) but **discarded** — `session.ts:462-490`'s `send()` returns only `boolean`, never stores the real value | **INCOMPLETE** — real captured values are `end_turn` (140×) and `cancelled` (1×); spec also defines `max_tokens`, `max_turn_requests`, `refusal` — none of these distinctions ever reach the UI. A turn that stops because of `refusal` or `max_turn_requests` looks identical to a normal `end_turn` completion today |
| `session/update` notification, all sub-kinds | see per-kind rows below | mixed, see below |
| `session/cancel` (Client→Agent notification) | `client.ts:128-130`, echoed locally `session.ts:492-509`, wired to the UI stop button (`acp-session-chat.tsx:792` `onStop: () => void cancel()`) | **CORRECT** end-to-end for the notification itself, verified live (real captured `stopReason: 'cancelled'`) |
| Spec requirement: "client must respond to pending `session/request_permission` with a `cancelled` outcome" on turn cancellation | **not implemented** — `cancel()` (`session.ts:492-509`) only sends `session/cancel`; it never walks `pendingPrompts.permissions` to answer them | **SPEC-VIOLATION, BROKEN-USER-VISIBLE — see Part 2, gap #1** |
| Spec requirement: "client should preemptively mark non-finished tool calls as cancelled" | not implemented — tool status only ever changes from agent-sent `tool_call_update`s | **INCOMPLETE**, minor/cosmetic |
| `promptCapabilities`-gated content restriction | never enforced — image attachments are always sent (`acp-session-chat.tsx:379`, `type:'image'`) with no check against `snapshot.capabilities.promptCapabilities.image` | **INCOMPLETE** — low real-world risk today since all 4 currently-integrated harnesses advertise `image:true`, but there's no defensive gate if a future/different adapter doesn't |

### `session/update` sub-kinds — [`prompt-turn.md`](https://agentclientprotocol.com/protocol/v1/prompt-turn), [`tool-calls.md`](https://agentclientprotocol.com/protocol/v1/tool-calls), [`agent-plan.md`](https://agentclientprotocol.com/protocol/v1/agent-plan), [`slash-commands.md`](https://agentclientprotocol.com/protocol/v1/slash-commands), [`session-modes.md`](https://agentclientprotocol.com/protocol/v1/session-modes), [`session-config-options.md`](https://agentclientprotocol.com/protocol/v1/session-config-options), [`session-list.md`](https://agentclientprotocol.com/protocol/v1/session-list)

| `sessionUpdate` kind | Real occurrences (9,923-envelope sample) | Where handled | Status |
|---|---|---|---|
| `agent_message_chunk` / `user_message_chunk` | 1,388 / 17 | `reduce.ts:393-474` | **CORRECT**, incl. replay-dedup |
| `agent_thought_chunk` | 4,348 | same | **CORRECT** |
| `tool_call` / `tool_call_update` | 280 / 1,520 | `reduce.ts:475-489`, `tool-part.ts` | **CORRECT** — status non-regression, per-harness tool-name normalization, diff/terminal content-block awareness |
| `usage_update` | 338 | `reduce.ts:544-563` | **CORRECT** |
| `plan` | **0** | `reduce.ts:490-508` (per-turn scoping, correctly implemented) | **CORRECT but UNVERIFIED LIVE** — code is right, but none of the 4 harnesses emitted a `plan` update anywhere in the captured sample; cannot confirm real-world behavior |
| `available_commands_update` | 169 (real payload: OpenCode's `customize-opencode`/`init`/`review`) | excluded from chat items by design (`reduce.ts:230-236`, correct); **but there is no other projection anywhere** — no `availableCommands` field exists on `AcpReducerState` or `AcpSessionSnapshot` | **MISSING — see Part 2, gap #2 (the owner's stated suspicion, confirmed)** |
| `current_mode_update` | 23 (all `currentModeId:"default"`) | excluded from chat items (correct), **also has no live projection** — no `currentModeId` field anywhere in the snapshot | **MISSING — see Part 2, gap #3** |
| `session_info_update` | 148 | `reduce.ts:591-600`, `transcript.ts`'s `AcpSessionInfo` | **CORRECT** — merges per-field, correctly handles both observed shapes (Claude `{title,updatedAt}`, Codex `{_meta.codex.threadStatus}}`); in-flight work (uncommitted `acp-envelope.ts`) is actively extending this for sidebar title sync right now |
| `config_option_update` | 21 | `reduce.ts:602-612`, feeds `composer-model-controls.tsx`/`reasoning-effort-selector.tsx` | **CORRECT**, well-integrated (model + `thought_level` categories) |

### Tool calls & permissions — [`protocol/v1/tool-calls.md`](https://agentclientprotocol.com/protocol/v1/tool-calls)

| Spec item | Where | Status |
|---|---|---|
| `RequestPermissionOutcome` shape | `session.ts:519-521` sends `{outcome:{outcome:'selected',optionId}}` / `{outcome:{outcome:'cancelled'}}` | **CORRECT** — confirmed against a real captured response row: `{"outcome":{"outcome":"selected","optionId":"allow"}}`. (Note: `schema.md`'s WebFetch extraction described this as a flat string enum, contradicting `tool-calls.md`'s object form — resolved here directly against real wire data: the object form is correct, the flat-enum reading was a summarization artifact) |
| `PermissionOptionKind` (`allow_once`/`allow_always`/`reject_once`/`reject_always`) | `transcript.ts:474-501` `resolvePermissionActionOptions` | **CORRECT**, with sensible pattern-matching fallback for non-conformant `kind` values |
| Turn-end cancellation must resolve open permission requests | not implemented | **SPEC-VIOLATION — Part 2 gap #1** |
| `ToolKind` enum passthrough | real captured kinds: `execute`, `fetch`, `read`, `edit`, `other`, `think` (of the spec's 9: `read/edit/delete/move/search/execute/think/fetch/other`) | **CORRECT** (generic passthrough + heuristic renderer classification, doesn't require special-casing every enum value) |
| Diff content block (`{type:'diff',path,oldText,newText}`) | dedicated `session-diff-viewer.tsx` exists; `tool-part.ts:131` explicitly skips flattening `diff`/`terminal` blocks to text, deferring to structured rendering | **CORRECT** (file-existence-verified, not line-by-line verified) |
| Terminal content block (`{type:'terminal',terminalId}`) | consistent with terminal capability never advertised | **N/A** |

### File system — [`protocol/v1/file-system.md`](https://agentclientprotocol.com/protocol/v1/file-system) / Terminals — [`protocol/v1/terminals.md`](https://agentclientprotocol.com/protocol/v1/terminals)

| Spec item | Status |
|---|---|
| `fs/read_text_file`, `fs/write_text_file` | **N/A** (architecture: harness has direct sandbox fs access; capability correctly never advertised, so this is a self-consistent non-support, not "advertise-but-don't-honor") |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | **N/A**, same reasoning |
| **Documentation vs. reality** | The SDK's own `packages/sdk/src/acp/README.md` (§1, "The canonical decision") claims ACP's contract includes *"terminal sessions"* as something Kortix uses. Real code advertises no terminal capability and implements zero `terminal/*` handlers. **Minor doc inaccuracy** — worth a one-line fix so a future reader doesn't go looking for terminal support that isn't there |

### Content blocks — [`protocol/v1/content.md`](https://agentclientprotocol.com/protocol/v1/content)

| Content type | Receive path | Send path | Status |
|---|---|---|---|
| `text` | `content.ts:16-19,55-59` | composer | **CORRECT** |
| `image` | `content.ts:26-33` | `acp-session-chat.tsx:379`, ungated by `promptCapabilities.image` | **CORRECT** receive / **INCOMPLETE** send (no capability gate, see above) |
| `audio` | `content.ts:26-33` | never sent (no audio-upload UI found) | **CORRECT** (implemented, unexercised) |
| `resource` / `resource_link` | `content.ts:35-49` | not verified as ever sent (no @-mention-to-`resource` path confirmed) | **CORRECT** receive / **UNVERIFIED** send |
| `annotations` field (`audience`/`priority`/`lastModified`) | never parsed anywhere | **INCOMPLETE**, low severity |

### Cancellation — [`protocol/v1/cancellation.md`](https://agentclientprotocol.com/protocol/v1/cancellation)

| Spec item | Where | Status |
|---|---|---|
| `session/cancel` (domain-specific) | see Prompt turn section above | **CORRECT** for the notification; **SPEC-VIOLATION** for the permission-resolution requirement it carries |
| `$/cancel_request` (generic, bidirectional, v1-stable since Jun 29 2026) | **zero handling anywhere** (`grep -rn "cancel_request\|32800"` across bridge/sdk/web/api returns nothing) | **MISSING** — real captured evidence: one live `$/cancel_request` (agent→client) observed at ordinal 10774 of a real session, arriving with no code path to interpret it; it falls through `reduce.ts`'s final `else` and renders as an unrecognized `raw` chat item. Low frequency (1 of 9,923) but directly evidences gap #1 below — see Part 2 |
| `-32800` error code | never specially surfaced | **INCOMPLETE** |

### Session config options — [`protocol/v1/session-config-options.md`](https://agentclientprotocol.com/protocol/v1/session-config-options)

All **CORRECT** — `session/set_config_option` (`client.ts:120-122`, `session.ts:531-546`), live `config_option_update` folding (`reduce.ts:602-612`), category-aware UI (`model`, `thought_level`). This is the best-integrated part of the whole surface, and per the spec itself is the *forward-looking* replacement for session modes (`session-config-options.md`: *"Clients SHOULD use `configOptions` instead of `modes`"*), so Kortix's choice to build the composer's model/thinking controls on this path instead of `session/set_mode` is the spec-endorsed direction, not a shortcut.

### Session modes — [`protocol/v1/session-modes.md`](https://agentclientprotocol.com/protocol/v1/session-modes)

| Spec item | Status |
|---|---|
| `session/set_mode` | **MISSING** — no method exists on `AcpClient` |
| `current_mode_update` live projection | **MISSING** (received, discarded — see table above) |

Severity note: the spec itself flags this whole feature as being phased out (*"Dedicated session mode methods will be removed in a future version of the protocol"*) in favor of session-config-options, which Kortix implements correctly. So this MISSING item is real but **low priority** — building it out would be investing in a feature the spec's own authors are sunsetting.

### Session list / delete — [`session-list.md`](https://agentclientprotocol.com/protocol/v1/session-list) / [`session-delete.md`](https://agentclientprotocol.com/protocol/v1/session-delete)

`session/list` and `session/delete`: never called. **N/A** — justified: Kortix tracks its own durable session identity in `project_sessions` (the SDK README's "3-identity model", §2) rather than relying on the harness's internal session bookkeeping. This is a deliberate, documented architectural choice, not an oversight.

### Slash commands — [`protocol/v1/slash-commands.md`](https://agentclientprotocol.com/protocol/v1/slash-commands)

See Part 2, gap #2 — the owner's stated belief is **fully confirmed**.

### Extensibility — [`protocol/v1/extensibility.md`](https://agentclientprotocol.com/protocol/v1/extensibility)

| Spec item | Status |
|---|---|
| `_meta` passthrough (lossless persistence, defensive reads of known shapes) | **CORRECT** — `reduce.ts`'s `extractSessionInfo` reads `_meta.codex.threadStatus` defensively; unknown `_meta` keys survive losslessly in the raw envelope log per the README's pinned "lossless JSONL" guarantee |
| Custom `_`-prefixed methods | not used by Kortix | **N/A** |
| Reserved W3C trace-context `_meta` keys (`traceparent`/`tracestate`/`baggage`) | not set by Kortix | **N/A/unverified** — no distributed tracing wired through ACP envelopes today |

### Transports — [`protocol/v1/transports.md`](https://agentclientprotocol.com/protocol/v1/transports)

| Spec item | Status |
|---|---|
| stdio (bridge ↔ harness process) | `runtime.ts` — real spawned child process, newline-delimited JSON-RPC on stdin/stdout, matches spec exactly | **CORRECT** |
| Streamable HTTP (spec's own transport) | explicitly marked **draft/unstable** in the v1 docs themselves (*"In discussion, draft proposal in progress"*) | **N/A** — not part of the stable v1 surface at all, nothing to implement |
| Kortix's own HTTP+SSE bridge (bridge ↔ SDK client) | `apps/kortix-sandbox-agent-server/src/routes/acp.ts`, `client.ts`'s `connect()` | This is **not itself an ACP spec item** — it's a legitimate "custom transport" under the extensibility rules (*"Agents and clients MAY implement additional custom transport mechanisms"*). Graded as **CORRECT** for internal soundness (proper `Last-Event-ID` bounded replay at a 2,000-event cap, 202/204 notification semantics, 409 on harness conflict, HMAC-gated) — pinned by a real test suite per the README (commit `8c7d49a64`) |

---

## Part 2 — the specific gaps, adjudicated

### Gap #1 — Cancelling a turn leaves open permission requests unanswered (BROKEN-USER-VISIBLE, SPEC-VIOLATION)

`prompt-turn.md` is explicit: on `session/cancel`, *"the client must respond to any pending `session/request_permission` requests with a `cancelled` outcome."* `AcpSession.cancel()` (`packages/sdk/src/acp/session.ts:492-509`) does not do this — it only sends the `session/cancel` notification and locally echoes it; it never walks `pendingPrompts.permissions` to call `respondPermission(id)`. The web stop button (`acp-session-chat.tsx:792`) calls only `cancel()`.

**Real evidence, not theoretical:** a captured session (ordinals 10742–10778) shows a `session/request_permission` (id `7`) opened at 10742, the user hitting Stop at 10773 (`session/cancel`), and the agent itself sending an unhandled `$/cancel_request` at 10774 — with the permission request not actually answered until ordinal 10778, the very last row of the session, after the cancel. This is the client leaving the harness hanging on a permission it should have proactively resolved.

**Fix**: in `cancel()`, before/alongside sending `session/cancel`, iterate `this.snapshot.pendingPrompts.permissions` and call `respondPermission(id)` with no `optionId` (→ `{outcome:{outcome:'cancelled'}}`) for each. **Lane: SDK** (`packages/sdk/src/acp/session.ts`), one function, testable against the existing fixture-driven `session.test.ts`.

### Gap #2 — Slash commands are fully dropped (MISSING-FEATURE, BROKEN-USER-VISIBLE, owner's stated belief CONFIRMED)

`available_commands_update` arrives correctly over the wire (169 real occurrences, real payload verified from OpenCode: `customize-opencode`/`init`/`review` with descriptions). It's correctly excluded from `chatItems` (it's not a chat message) — but there is **no other projection anywhere**. `AcpReducerState`/`AcpSessionSnapshot` have no `availableCommands` field at all. `useRuntimeCommands()` (`packages/sdk/src/react/use-runtime-sessions/commands.ts:16-32`) hardcodes `commands: Command[] = []` with a comment that already names the gap: *"ACP commands are session-scoped and arrive through `available_commands_update`; there is no harness-global command API."*

Split finding: the **execution** half is fine — `useExecuteRuntimeCommand()` (same file, lines 34-63) correctly builds `/${command} ${args}` and sends it via `session.prompt()`. Only **discovery** is broken. The composer's "/" affordance has no real per-session, per-harness command list to back it.

**Fix**: thread `available_commands_update` through the reducer into a new `AcpSessionSnapshot.availableCommands` field (mirrors how `config_option_update` already threads into `liveConfigOptions`), then point `useRuntimeCommands()` at the live session snapshot instead of returning `[]`. **Lane: SDK** for the plumbing, **web** for wiring the composer's "/" menu to it. A build task for this is already queued per the brief — this finding is its evidence base.

### Gap #3 — Session Modes: real protocol data received and discarded, but low priority

`current_mode_update` arrives (23 real occurrences, all `currentModeId:"default"` — never observed changing) and is discarded exactly like available-commands: excluded from chat items, no `currentModeId` field anywhere in the snapshot, and `session/set_mode` doesn't exist on `AcpClient` at all. What the web UI calls "mode pills" is actually the composer's reasoning-effort/model selector, built correctly on `session/set_config_option` + `config_option_update` (a different, v1-stable, spec-endorsed mechanism — see Part 1). Since the spec itself is sunsetting dedicated mode methods in favor of config options, this MISSING item is real but not worth prioritizing unless a harness starts using multi-mode switching (e.g. Zed-style "ask"/"architect"/"code") for something Kortix's config-options UI can't express.

### Gap #4 — Capability negotiation is inert (root cause behind #1–#3 and more)

Covered in Part 0. `agentCapabilities` round-trips correctly at `initialize` and is stored, then read by nothing. This is why image attachments are sent unconditionally, why `session/resume` (advertised by 3/4 harnesses) is never used in favor of the costlier `session/load`, and why there's no defensive check before sending content types a given harness might not support. **Fix**: make `snapshot.capabilities` a first-class input to composer/session behavior, not just a stored artifact. **Lane: SDK + web**, cross-cutting, worth its own small design pass rather than four separate patches.

### Gap #5 — `session/resume` and `mcpServers` are unused spec-native mechanisms

Two distinct MISSING items, both potentially higher-value than their current priority suggests:
- `session/resume` (no-replay reconnect) is advertised by Claude/Codex/OpenCode and never called — every reconnect pays full-history-replay cost via `session/load` instead.
- `mcpServers` is always `[]` at `session/new`/`session/load` — ACP's native mechanism for exposing MCP servers/tools to the harness is wired and permanently empty. If there's a product intent to expose Kortix's MCP/connector surface *to* these coding-agent harnesses, this is the built-in path and it's currently a no-op — worth a deliberate decision (use it, or explicitly note it's out of scope) rather than a silent gap.

---

## Part 3 — verdicts and summary

**Rank key**: (a) BROKEN-USER-VISIBLE — explains a real symptom · (b) SPEC-VIOLATION — works by luck/against spec · (c) MISSING-FEATURE — spec offers, we drop · (d) fine as-is.

| # | Finding | Rank | Minimal fix | Lane |
|---|---|---|---|---|
| 1 | Cancel leaves permission requests unanswered | (a)+(b) | `cancel()` resolves `pendingPrompts.permissions` with `cancelled` outcome | SDK |
| 2 | Slash commands: discovery discarded, execution fine | (a)+(c) | Thread `available_commands_update` → `snapshot.availableCommands`; wire composer "/" to it | SDK + web |
| 3 | `stopReason` fetched, discarded | (c) | Store real `stopReason` on the snapshot; branch UI on `refusal`/`max_turn_requests` | SDK |
| 4 | `$/cancel_request` unhandled | (c) | Low-freq (1/9,923); add minimal handling so it doesn't render as a stray "raw" row | SDK |
| 5 | Capability negotiation inert | (b) (structural) | Make `snapshot.capabilities` gate real decisions instead of sitting unread | SDK + web |
| 6 | `session/resume` unused, `session/load` always pays replay cost | (c), perf | Add `resume()` to `AcpClient`, prefer it on plain reconnects | SDK |
| 7 | `mcpServers` always `[]` | (c), product-scope question | Decide: wire real MCP servers through, or document as intentionally out of scope | product + SDK |
| 8 | Session Modes (`set_mode`/`current_mode_update`) unimplemented | (c), low priority | Spec itself is sunsetting this in favor of config-options, which is CORRECT | n/a — accept |
| 9 | README overclaims "terminal sessions" support | (d), doc-only | One-line correction | SDK docs |
| 10 | Image attachments sent without `promptCapabilities.image` gate | (b), low real risk | Add the check | web |

**Matrix summary** (counts from Part 1's ~50 graded spec items, including justified N/A rows): **≈24 CORRECT** (initialize, session/new, session/load, session/prompt, session/cancel wiring, most `session/update` sub-kinds, permission handling shape, content-block receive paths, session-config-options end-to-end, transports, extensibility passthrough) · **≈10 INCOMPLETE** (stopReason discarded, capability gating absent, error-code differentiation absent, annotations dropped, preemptive tool-call cancellation, `$/cancel_request`) · **1 clear INCORRECT** none rising to full spec-violation-in-the-wrong-direction beyond gap #1's omission · **≈8 MISSING** (`authenticate`, `logout`, `session/resume`, `session/close`-as-N/A-but-`session/set_mode` genuinely missing, `additionalDirectories`, `mcpServers` population, available-commands projection, current-mode projection) · **≈9 N/A** (fs/terminal — architecture-justified, session/list/delete/close — identity-model-justified, Streamable HTTP transport — spec itself marks it draft).

---

### Executive summary (10 lines)

1. **We do use v1, correctly** — `protocolVersion:1` on 100% of 253 real `initialize` calls, both directions, all four harnesses. The "are we mixing v1/v2" worry is unfounded.
2. v1 is a living spec — `session_info_update`, `config_option_update`, `usage_update`, resume/close/delete/list/additionalDirectories are all v1-stable (stabilized Mar–Jul 2026), not v2 leakage.
3. The real gap: capability negotiation happens correctly at `initialize` and then **drives nothing** — `snapshot.capabilities` is stored, never read by web or SDK.
4. **Confirmed, exactly as suspected**: slash commands are received (169 real events, real command lists) and completely discarded before reaching the composer — `useRuntimeCommands()` hardcodes `[]`.
5. **New, higher-severity finding**: cancelling a turn does not resolve open permission requests, violating an explicit spec MUST — proven against a real captured session, not just theoretical.
6. `stopReason` (refusal / max-tokens / max-turn-requests / cancelled / end-turn) is fetched and thrown away — the UI can't tell a refusal from a clean finish.
7. `session/resume` is advertised by 3 of 4 harnesses and never used — every reconnect pays full-history-replay cost via `session/load` instead.
8. `mcpServers` is always sent empty — ACP's native path for exposing tools to the harness is wired and unused; worth a product decision either way.
9. File-system and terminal capabilities are correctly *not* advertised (harness has direct sandbox fs access) — this is sound architecture, not a gap, despite one stale doc line claiming otherwise.
10. Priority order: fix #1 (permission-stuck-on-cancel) first — it's a real bug with real evidence; #2 (slash commands) next since a build task is already queued on it; the rest are lower-severity completeness/perf items.
