# UX/UI completion plan: providers, models, selectors, session-chat parity

Status: execution plan, derived from 4-agent audit of `acp-harness-runtime-v2`
Date: 2026-07-14
Parent specs: `2026-07-14-provider-auth-model-management.md`, `2026-07-14-models-page-ui-handoff.md`

## 0. Governing decision

The parent spec's `ModelConnection` backend (connection records with IDs, multi-connection-per-kind,
test/discover endpoints, harness-route table) **does not exist** and is a multi-week backend lift.
The UX/UI work does **not** wait for it. We build the target UX on today's honest data layer:

- `GET /projects/:id/harness-connections` — 8 auth-kind "connections" with `configured/ready/active_for`
- `GET /projects/:id/composer-capabilities?agent_name=` — per-agent capability resolution
- `GET /projects/:id/model-catalog` + `GET /projects/:id/llm-catalog` — model presets
- `PUT /projects/:id/harness-connections/:harness/active` — route selection
- secrets CRUD + Codex OAuth device flow

Consequences accepted for now (each becomes richer when the backend lands, without changing page shape):

1. Connection identity = auth-kind string. Every kind is a singleton (one Claude subscription, one
   custom endpoint, one Anthropic key per project). UI copy never says "add another" for now.
2. No live "Test connection" — status = configured/ready from the API. The Manage modal omits Test.
3. Custom endpoint keeps the `CUSTOM_LLM_*` singleton but gets the new form UX (name, protocol,
   base URL, key, model ID) and the new row presentation.
4. All handoff language rules (§2 of the handoff) apply verbatim: connection, Kortix managed,
   Claude subscription, ChatGPT subscription, Harness default, Automatic, Custom endpoint, Uses.

Multiple subscriptions/keys per project, team sharing, routing between several credentials, and
"any API key with the Claude Code/Codex harnesses" are **product decisions + backend work** —
tracked in §5, not blocked on here.

## 1. Workstream A — Session-chat parity with main (highest priority)

Finding: the shared primitives (`session-chat-input.tsx`, `model-selector.tsx`,
`harness-model-selector.tsx`, `tool-renderers.tsx`, `question-prompt.tsx`,
`session-approval-prompt.tsx`, `chat-minimap`, `animated-thinking-text`) are intact and at parity.
The regression is entirely in `acp-session-chat.tsx` (295-line MVP replacing main's 5,381-line
`session-chat.tsx`) not wiring them. Reference source: `git show main:apps/web/src/features/session/session-chat.tsx`.

### A1. Composer wiring in live sessions (critical)
`AcpSessionChat` passes only `sessionId/onSend/isBusy/onStop/disabled/placeholder/messages/acpUsage/onContextClick`
to `SessionChatInput`. Wire the full set the way `composer-chat-input.tsx` already does pre-session:
`agents`, `selectedAgent` (locked/read-only — agent is immutable live), `models`/`selectedModel`/
`onModelChange` or `harnessModel` per `agentModelPolicy`, `variants`, `commands`/`onCommand`,
`onFileSearch`, `mentionSessions`, `todos`, `queuedMessages`/`onQueueMessage`, `replyTo`/`onClearReply`,
`modelDefaultControls`. Prefer delegating to `ComposerChatInput` with a live-session mode over
re-wiring by hand. Selectors live **in the composer bottom toolbar**, never a top strip.

### A2. Kill the top config bar
The raw `<Select>` strip above the transcript (`acp-session-chat.tsx:119-133`, built from ACP
`configOptions`) moves into the composer toolbar as pill-styled controls (same affordance family as
`HarnessModelSelector`). A model-typed config option renders as the model pill; other options render
as compact pills next to it.

### A3. Permission prompt restoration (critical)
Port main's `SessionPermissionPrompt` (amber card, "Deny / Allow once / Allow for session",
"Allow everything", project-level "Always allow", auto-approve indicator) onto ACP
`respondPermission(id, optionId)`. Pinned via `SessionChatInput`'s `inputSlot`, never in-stream.
Map ACP permission options onto the three-tier scopes; fall back gracefully when a harness offers
fewer options.

### A4. Question prompt restoration (critical)
Replace `AcpQuestionCard` with main's `QuestionPrompt` chip UX (markdown, tabbed multi-question,
custom answers typed in the main composer) via existing `SessionChatInputProps`
(`lockForQuestion`/`onCustomAnswer`/`questionButtonLabel`/`onQuestionAction`), driven by ACP
respond/reject.

### A5. Connector approvals
Mount the untouched `SessionApprovalPrompt` in `inputSlot`.

### A6. Transcript rendering parity
Match main: root `pt-10`, wallpaper/welcome (`SessionWelcome` + crossfade), `role="log"`,
`scrollbar-hide`, `max-w-3xl px-3 sm:px-6`, `mt-12` turn gaps; user bubble `bg-card rounded-3xl
rounded-br-lg border max-w-[90%]` with `HighlightMentions`, reply-context strip, `GridFileCard`
attachments; Kortix logomark header instead of per-message Bot/Brain icons; `SameToolGroup` +
`GroupedReasoningCard` grouping with left rail; hover-reveal Copy buttons + response footer
(duration/cost); sub-session report chip + `SubSessionModal`; styled unknown-method fallback using
tool-card chrome; `AcpPlanCard` adopts tool-card chrome.

### A7. Busy/streaming indicator
`AnimatedThinkingText` + pulsing dot + duration counter, fed by live ACP status/tool name; retry state.

### A8. Scroll/minimap/reply
Main's scroll-to-bottom button (ArrowDown icon, label, shadow, enter/exit transition), `ChatMinimap`,
selection→Reply popup wired to restored `replyTo`.

### A9. Restorations to confirm/do
- `BranchPicker` in `project-home.tsx` `toolbarSlot` (deleted without ACP justification — restore).
- `supportsCompact={false}` on ACP sessions — keep off only if compaction truly unsupported by ACP
  runtime; otherwise restore.
- "Session not found" state.

## 2. Workstream B — the Models page (replaces the three-tab modal)

Implement the handoff doc's one-page design (§3-§10 are the authority for layout, language, states,
and component rules) **backed by today's endpoints**:

- `ModelsPageState.runtimes` ⇦ derive from project agents (`config.agents` → harness set) joined
  with `useHarnessConnections` (`active_for`, `ready`) and `useComposerCapabilities` summaries.
- `ModelsPageState.connections` ⇦ `useHarnessConnections().connections` filtered to
  `configured || ready`, plus Kortix managed; names from the locked language table; `usedBy` from
  `active_for`; catalog counts from `model-catalog`/`llm-catalog`; subscriptions always
  "Models managed by Claude Code/Codex", never a count.
- Change selector ⇦ `setActiveHarnessConnection` with optimistic revert on failure +
  `successToast('<Runtime> now uses <Connection>')`.
- Connect modal ⇦ categorized method list (Subscriptions / API keys / Custom endpoint) reusing the
  existing forms, restyled: `claude-subscription-connect`, `chatgpt-subscription-connect` (device
  flow), generic API-key form, custom endpoint form. Final "Use with <runtime>" step calls
  `setActiveHarnessConnection` (checked when first compatible connection).
- Manage modal ⇦ status, used-by, Reconnect/Replace key, models list where applicable, Disconnect via
  `ConfirmDialog` with fallback preview (route unset + secret delete, as `connected-tab.tsx` does today).
- The derivation hook lives in `@kortix/sdk` (`useModelsPage(projectId)`) so the host stays thin —
  it wraps today's queries now and swaps to `/model-connections` later.

Deletions once the page lands: `llm-provider-modal.tsx` tabs, `connected-tab.tsx` routes matrix,
`models-tab.tsx` (visibility manager), `catalog-tab.tsx` list/detail as a tab, singleton
`use-connected-providers` provider inference. Entry points (`gateway-view`, `secrets-view`,
command palette, `use-model-connection-gate`, model-selector "Manage models") retarget to the page.
Model visibility toggles are demoted to a display-only preference reachable from the model selector
(not a page tab), or dropped if redundant.

## 3. Workstream C — composer/selector correctness and polish

From the composer audit (`use-model-connection-gate`, `session-chat-input`, `composer-chat-input`):

1. **Dashboard composer is inert**: `dashboard-content.tsx` `createSession.mutateAsync()` sends no
   agent/model/connection. Forward `agent_name` + `model_selection` (extend
   `buildRuntimeSessionCreateInput`); the index-page selector must actually bind the session.
2. **Retire the legacy gate**: remove `NO_MODEL_AVAILABLE_MESSAGE`, `model-availability.ts` universal
   block, and the `hasSelectableModels` OR-path; `composer-capabilities` (`can_start`/`blocking_reason`)
   becomes the only send gate, with direct actions ("Connect Claude Code", "Choose a model for
   <connection>") instead of generic copy.
3. **Empty-catalog must not block**: OpenCode `defaultAllowed` backend rule
   (`composer-capabilities.ts:348`) requires presets>0 — align so a valid native/managed default
   enables Send with `choices.length === 0` (frontend never re-derives this).
4. **`runtimeModel` leak**: key by agent name, persist alongside the catalog-model store.
5. **Dead start-stash fields**: stop writing/declaring `agent/model/variant` in `StartStash`.
6. **Type gap**: declare `connection_id`/`model_selection` on `useNewProjectSession`'s `create` type.
7. **Subscription copy**: `HarnessModelSelector` shows "Models managed by Claude Code/Codex" +
   `via Claude subscription` secondary line; agent selector rows keep harness badges.
8. **Agent switch** clears incompatible remembered model state (per-harness policy change).
9. **Dedupe derivations**: one shared source for `freeTier`/`llmGatewayEnabled` instead of three copies.
10. **"Manage models" link** in the selector opens the new Models page surface.

## 4. Sequencing

Wave 1 (parallel, disjoint files): A1-A5 (acp-session-chat + prompts) ∥ B (new llm-provider page files).
Wave 2: A6-A9 (transcript polish) ∥ C (composer internals; touches session-chat-input after A1 merges).
Wave 3: verification — `tsc` per package, bun tests, browser pass at 1440/1024/768/390/320 in
light+dark, real session create for all four harnesses, screenshots.

## 5. Open product decisions (need Marko, not blocking waves 1-2)

1. Multiple connections of one kind (2 Claude subscriptions shared across a team, key pools/routing)
   — requires the `ModelConnection` backend (§3 of parent spec). Approve as follow-up backend project?
2. "Any API key through Claude Code/Codex harnesses" (e.g. Anthropic-compatible custom endpoint into
   Claude Code) — adapter capability work + env translation exists in `harness-registry.ts`; needs
   explicit compatibility matrix + testing. In favor per Marko, scope after UI lands.
3. Model visibility manager: keep as display-only preference or delete outright?
4. Compact-session for ACP runtimes: supported or permanently hidden?
