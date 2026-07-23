# ACP SDK hardening + web UX — design

Status: approved design, awaiting implementation plan
Date: 2026-07-14
Owner: Jay (SDK ACP surface + web migration; spec steps 5–6 of
`docs/specs/2026-07-12-acp-harness-runtime.md`)
Source review: deep review of the SDK ACP first slice on `acp-harness-runtime-v2`
(PR #4510), 2026-07-14 session.

## Goals

1. Fix every correctness bug found in the SDK ACP slice review, with the four
   user-facing blockers fixed **before** #4510 merges.
2. Restructure the SDK ACP client state around a framework-free `AcpSession`
   store so web, mobile, and whitelabel share one engine (SDK core law:
   framework-free first).
3. Bring the ACP web surface (harness/model/mode selector, chat transcript,
   permission/question/tool/plan cards, session states) to production quality
   for ~400k users: no stuck cards, no duplicate messages, no wedged sessions,
   no streaming jank.

## Non-goals

- The v1 public-API aliasing / major-version decision (80+ removed exports).
  That is a PROGRESS.md hard-stop owned by Marko/Jay jointly; this design
  assumes it is resolved separately.
- Mobile (RN transcript polling) verification and whitelabel PR #4470 rebase.
  Both consume this work later; neither blocks it.
- PR #4120 (`refactor/action-panel`) itself. Its rebase strategy is documented
  in the review; this design only sequences around it.

## Success criteria

- Permission/question cards clear immediately on response; double-submit is
  impossible.
- StrictMode double-mount and effect re-runs create **zero** extra ACP
  sessions and zero duplicate chat rows.
- A reload mid-turn recovers: busy state reflects reality and `send` is never
  permanently blocked.
- Streaming: ≤1 React commit per animation frame; no commit >16ms at 5,000
  envelopes (proven by a replay fixture + profiler assertion, not by feel).
- Selector open <200ms perceived; INP <200ms on the session page.
- Every ACP surface passes the kortix-design-system checklist and the
  make-interfaces-feel-better review checklist; motion follows the
  animations.dev doctrine (ease-out, <300ms, no keyboard-action animation,
  `prefers-reduced-motion` respected).
- SDK gates green: `pnpm --filter @kortix/sdk typecheck && test &&
  smoke:install`, full-suite counts at or above baseline.

## Workstream 0 — pre-merge fixes for #4510

Small, self-contained diffs handed to Marko (or PR'd onto
`acp-harness-runtime-v2` after coordination). No API changes.

| # | Bug | Location | Fix |
|---|-----|----------|-----|
| 0.1 | Permission/question cards never clear after responding (blocker): responses persist as `client_to_agent`, SSE only streams `agent_to_client`, so `projectAcpPendingPrompts` never sees the answer until reload. Double-submit possible. | `packages/sdk/src/react/use-acp-session.ts:98-100`; verified against `apps/api/src/projects/routes/acp.ts:126,155-199` | `respondPermission`/`respondQuestion`/`rejectQuestion` append an optimistic `client_to_agent` response envelope on success, exactly as `send` does at line 92. |
| 0.2 | `reconnect: false` ignored on the error path — one-shot connects retry forever. | `packages/sdk/src/acp/client.ts:169-181` | Check `options.reconnect === false` after the catch as the poll path already does (`client.ts:228,232`). |
| 0.3 | CRLF-delimited SSE parses to zero events: boundary scan is `indexOf('\n\n')` before `\r` strip. | `packages/sdk/src/acp/client.ts:273-277` | Normalize `\r\n`→`\n` in the buffer before boundary scanning, carrying a trailing `\r` across chunk reads. |
| 0.4 | Effect re-run calls `session/new` again when `runtimeSessionId` is null — leaked/duplicate upstream ACP sessions on StrictMode double-mount or `enabled` toggle. | `packages/sdk/src/react/use-acp-session.ts:58-67,86` | Track the created ACP session id in a ref; re-runs `session/load` it instead of minting a new session. (Superseded properly by Workstream A; this is the minimal guard.) |

Each fix ships with the failing test first (package law), authored to survive
the later store extraction: 0.2/0.3 test `AcpClient` directly; 0.1/0.4 test
observable hook behavior, not implementation.

## Workstream A — SDK: framework-free `AcpSession` store

### A1. New module `packages/sdk/src/acp/session.ts`

Isomorphic-core tier (no React, no node:, no bare globals). One class owns
everything `useAcpSession` currently juggles in `useState`/`useEffect`:

```ts
type AcpConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';

type AcpSessionSnapshot = {
  envelopes: readonly AcpStoredEnvelope[];
  chatItems: readonly AcpChatItem[];       // incrementally maintained
  pendingPrompts: AcpPendingPrompts;       // incrementally maintained
  usage: AcpUsageProjection | null;
  turnState: AcpTurnState;
  connection: AcpConnectionState;
  ready: boolean;
  busy: boolean;
  error: AcpSessionError | null;           // structured, not string
  acpSessionId: string | null;
  configOptions: AcpSessionConfigOption[];
  capabilities: Record<string, unknown>;
  agentInfo: AcpInitializeResult['agentInfo'] | null;
  authMethods: Array<Record<string, unknown>>;
};

class AcpSession {
  constructor(options: { endpoint: string; acpSessionId?: string | null; cwd?: string;
    clientInfo?: {...}; fetch?: typeof fetch; streamTransport?: ... });
  connect(): void;                          // idempotent; single-flight bootstrap
  close(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): AcpSessionSnapshot;        // stable identity between emissions
  send(prompt: AcpContentBlock[]): Promise<boolean>;
  cancel(): Promise<void>;
  respondPermission(id: AcpJsonRpcId, optionId?: string): Promise<void>;
  respondQuestion(id: AcpJsonRpcId, content: Record<string, unknown>): Promise<void>;
  rejectQuestion(id: AcpJsonRpcId): Promise<void>;
  setConfigOption(configId: string, value: unknown): Promise<boolean>;
}
```

Behavioral requirements:

- **Idempotent lifecycle.** `connect()` twice = one stream, one bootstrap.
  Bootstrap (`initialize` → `session/load|new`) is single-flight and records
  the created ACP session id internally, so no code path can mint a second
  `session/new`. StrictMode-proof by construction, not by guard flags.
- **Incremental reducer.** State updates apply one envelope at a time. Tool
  calls are tracked in an id→index map (O(1) amortized per event; kills the
  `items.find` O(n²)). Message chunks append to the tail item. Pending
  prompts maintain an answered-id set incrementally. `projectAcp*` functions
  remain exported (they are public API) and become "reduce from scratch"
  wrappers over the same reducer step, so both paths share one
  implementation.
- **Structural sharing.** Only the items touched by an envelope get new
  object identity; untouched `chatItems` entries are reference-stable across
  snapshots so memoized React rows skip re-render.
- **Batching.** Events received within one microtask/rAF window coalesce into
  a single snapshot emission — at most one listener notification per frame
  regardless of chunk rate.
- **Optimistic echoes** for prompts *and* responses (fix 0.1 folded in),
  reconciled against server rows by ordinal; dedupe keys cover
  `client_to_agent` rows (fixes the duplicate-user-bubble merge bug at
  `use-acp-session.ts:48-51`).
- **Busy-staleness policy** (fixes the wedged-busy bug): a persisted pending
  prompt no longer counts toward `busy` when (a) a `session/cancel` for the
  same session follows it in the log, or (b) a newer `session/prompt`
  supersedes it. `send()` always allows overriding persisted-only busy (the
  override is itself case (b) once sent). If the bridge later exposes an
  in-flight-request probe, it can be added as a third signal — not required
  for this design. Live request busy (`requestBusy`) is unchanged.
- **Structured errors.** `error` is `{ kind: 'transport'|'rpc'|'bootstrap',
  message, status?, code?, terminal: boolean }`. Transient stream errors
  clear automatically on recovery (fixes the sticky error banner).

### A2. `useAcpSession` becomes a thin wrapper

`useSyncExternalStore(session.subscribe, session.getSnapshot)` over a
memoized `AcpSession` instance. **Existing return contract preserved**
(additive only): adds `acpSessionId` and `connection`; `runtimeSessionId`
remains as a deprecated alias of `acpSessionId` (spec's identity-overloading
fix without a breaking rename). Start-stash replay stays in the react layer.
`cwd`, `clientInfo`, `protocolVersion` become injectable options with current
values as defaults; `clientInfo.version` reads from a build-stamped constant,
not a hardcoded string.

### A3. Transport hardening (`packages/sdk/src/acp/client.ts`)

| Fix | Detail |
|-----|--------|
| Error taxonomy | `AcpTransportError extends Error { status, terminal }`. Terminal: 4xx except 408/429 (includes the spec's 409 harness-mismatch). Terminal errors stop the reconnect loop and surface `connection: 'failed'`. |
| Backoff | Reset `retryMs` only after the first event arrives (or N seconds connected), not on successful fetch. Add ±30% jitter. Cap stays 5s. |
| JSON-RPC ids | Collision-resistant across instances/reloads: string ids `${epochMs}-${counter}` (JSON-RPC permits string ids; the bridge passes them through). `projectAcpTurnState`/`projectAcpPendingPrompts` additionally match response-after-request by ordinal ordering as a backstop for old persisted logs. |
| Response verification | `request()` asserts the response id matches the request id. |
| Poll replay | `pollTranscript` seeds from `options.lastEventId` instead of always 0. |
| Daemon mode | `baseUrl + serverId` construction accepts an `agent` option and appends `?agent=` on POST (spec line 102). |
| Abort hygiene | Check `signal.aborted` upfront; remove abort listeners on close; `transcript()` accepts a signal and is aborted by `close()`. |
| SSE conformance | CRLF (0.3); single-leading-space `data:` handling; `id: 0` accepted (`lastEventId` tracked as `number \| null`, null meaning "none seen"); poison event (unparseable data with valid id) skips-with-`onError` instead of infinite replay. |
| Connection state | `connect()` reports `connecting/open/reconnecting/closed/failed` transitions to the store. |

### A4. Reducer/projection fixes (`packages/sdk/src/acp/transcript.ts`)

- **Explicit method table** replaces substring sniffing
  (`isPermissionMethod`/`isQuestionMethod` at lines 463-469):
  `session/request_permission` → permission; `elicitation/create` (and the
  ACP-documented elicitation methods) → question; everything else → raw.
  Extension point: `AcpMethodClassifier` option so harness-specific methods
  can be registered without SDK releases.
- **Terminal status guard**: `mergeToolCall` never regresses
  `completed|failed|error` to a non-terminal status (line 302).
- **Per-turn plan**: a `plan` update after a user prompt creates a new plan
  item in the current turn instead of mutating the first plan (lines 164-168).
- **Non-visual updates**: `usage_update`, `current_mode_update`,
  `available_commands_update` are consumed by their projections and excluded
  from `projectAcpChatItems` (no more JSON rows in chat, line 169).
- **Type hygiene**: `AcpStoredEnvelope.direction` narrows to the two-literal
  union (drop `| string`); `transcript()` return row gets a named exported
  type; react's duplicate `AcpStoredSessionEnvelope` becomes a deprecated
  alias of it.

### A5. Transcript exports (`acpTranscript*`)

Rebased on `readonly AcpStoredEnvelope[]` (accepting the persisted log),
coalescing message chunks before rendering. JSONL becomes lossless: emits
`{ ordinal, direction, streamEventId, createdAt, envelope }` per row.
Markdown renders one section per coalesced message/tool, not per chunk.
Old `AcpStreamEvent[]` signatures remain as deprecated overloads (published
API; alias-never-replace).

### A6. Tool-call normalization moves into the SDK

`acpToolCallToPart` + `acpToolName` + input/status normalization move from
`apps/web/src/features/session/acp-tool-call-card.tsx` into
`packages/sdk/src/acp/` (framework-free, next to `projectToolCall`), typed
against `ToolPart` semantics without the `as ToolPart` cast. Web imports the
SDK function; mobile/whitelabel reuse it. Elicitation answer coercion against
`requestedSchema` (`"true"`→boolean, `"42"`→number per property type) also
lands SDK-side next to `questionItemsFromSchema`.

## Workstream B — web UI/UX

Design law: kortix-design-system tokens win; make-interfaces-feel-better
polish applies within them; animations.dev doctrine for motion (ease-out,
<300ms UI durations, springs `{duration: 0.3, bounce: 0}` for icon/state
morphs, no animation on keyboard-initiated actions, `prefers-reduced-motion`
strips movement but keeps opacity).

### B1. Harness/model/mode selector

- **Delete** the raw `Select` bar above the chat
  (`acp-session-chat.tsx:119-133`).
- ACP `configOptions` route into the composer selector system:
  - Model-typed options feed the existing `HarnessModelSelector` /
    `ModelSelector` (`apps/web/src/features/session/harness-model-selector.tsx`,
    `model-selector.tsx`), preserving the e2e contract
    (`data-testid="harness-model-selector"`, `agent-option`, `data-harness` —
    `tests/e2e/specs/14-acp-harness-selector.spec.ts`).
  - Mode-typed options render as a compact segmented control in the composer
    row using `TabsListCompact`/`TabsTriggerCompact` (the design system's
    filter-tab primitive; matches peer controls in `changes-view.tsx`).
  - Remaining select-typed options go into a single overflow popover
    (settings icon + `Hint`), not a row of naked selects.
- Harness identity (`agentInfo.name`) renders as `Badge variant="outline"
  size="sm"` in the session header.
- Popovers are origin-aware (`transform-origin` from trigger), 150–200ms
  strong ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`), triggers get
  `active:scale-[0.97]` + `transition-colors`.
- `setConfigOption` in flight: optimistic value + `Loading` (from
  `loading.tsx`, never `Loader2`) in the trigger; on failure `errorToast` +
  revert. The dropdown never freezes.

### B2. Streaming transcript

- Per-item memoized row components (`memo(AcpChatItemRow)`), keyed by stable
  ids: message id (server ordinal-derived), tool-call id, request id — never
  array index (today: `acp-session-chat.tsx:152,158,171,174`).
- `isStreaming` (markdown streaming affordance) only on the tail item.
- Store batching (A1) caps commits at 1/frame; rows' reference stability
  makes those commits cheap.
- New-item enter: `opacity 0→1` + `translateY(8px)→0`, 250–300ms ease-out.
  **No enter animation on history load** (`initial={false}` semantics — the
  first snapshot renders statically).
- Virtualization is **deferred behind a measurement gate**: only if the
  replay fixture (B5) shows >16ms commits at 5k envelopes after
  memoization+batching do we add a virtual list (turn-grouping + auto-scroll
  + virtualization is complexity we don't buy blind).

### B3. Permission and question cards

- Keyed by `JSON.stringify(request.id)`; `AcpQuestionCard` form state
  survives reprojection.
- Pending permission card: `bg-popover rounded-md border px-4 py-3`, leading
  `size-9` tinted tile `bg-kortix-orange/15` + `ShieldCheck size-5
  text-kortix-orange`, title `text-sm font-medium`, patterns as `code` rows,
  options as `Button size="sm"` with ≥40×40px hit areas, reject as
  `variant="outline"`.
- Responding: pressed option shows `Loading className="size-3.5 shrink-0"`,
  all options disable, then the card crossfades (blur `4px→0`, scale
  `0.25→1` on the icon swap, opacity, spring `{type: 'spring', duration: 0.3,
  bounce: 0}`, `AnimatePresence initial={false}`) into a compact answered
  row: `size-9` tile `bg-kortix-green/15` + check, one-liner "Allowed —
  {permission}" / "Rejected — {permission}" in `text-xs text-muted-foreground`.
  Optimistic echo (A1) makes this instant; failure = `errorToast` + card
  returns to pending (no unhandled rejections —
  `acp-session-chat.tsx:163-164,171,194`).
- Question card: same shell; typed answers via SDK coercion (A6); multi-select
  options as toggle `Button variant={selected ? 'secondary' : 'outline'}`;
  submit disabled until complete (unchanged) but with `Loading` while in
  flight.

### B4. Tool cards, plan card, raw frames, session states

- Tool cards keep delegating to `ToolPartRenderer` (and #4120's `tool/`
  registry post-rebase); the adapter comes from the SDK (A6). `defaultOpen`
  on error stays. Status colors only via `kortix-*` tokens.
- Plan card: per-turn (A4), entries with status ticks (`kortix-green` check /
  `muted-foreground` pending), `ListTodo` in a neutral tile.
- Raw protocol frames leave the main flow: collected behind one muted
  "Protocol events (n)" `Disclosure` per turn, `text-xs`, for debugging.
- States: boot = shape-matched `Skeleton` rows (not a spinner); brand-new
  session = `EmptyState`; terminal connect failure (`AcpTransportError.terminal`)
  = `ErrorState size="sm"` + retry `Button`; transient reconnect = quiet
  composer pill "Reconnecting…" + `Loading`, driven by `connection` state —
  transcript never blanks, banner clears on recovery; busy = existing
  working indicator, stop button always live; context/usage indicator uses
  `tabular-nums`.

### B5. Performance proof (lands as tests, not vibes)

- Deterministic envelope-replay fixture: a recorded real ACP session
  (~2k chunks, tool calls, permissions) replayed through `AcpSession` at
  accelerated speed.
- Unit-level: profiler assertion that a chunk append re-renders only the tail
  row (React Profiler `onRender` commit count in a jsdom/bun test).
- e2e: Playwright trace on the session page during replay; assert no long
  tasks >50ms attributable to transcript rendering; INP <200ms.
- Budget numbers live in the test, so regressions fail CI.

## Testing summary

- SDK unit (bun, co-located): SSE framing (CRLF, split chunks, multi-line
  data, poison event, `id: 0`), reconnect/backoff/jitter/terminal-error,
  Last-Event-ID replay + dedupe, poll-path replay seed, id-collision
  backstop, reducer edges (update-before-start, terminal regression,
  duplicate ids, per-turn plans, non-visual updates), store lifecycle
  (double-connect, close-mid-bootstrap), busy-staleness matrix, optimistic
  echo reconciliation, transcript exports (lossless JSONL round-trip,
  coalesced markdown).
- React: `useAcpSession` test file (StrictMode double-mount, snapshot
  stability, alias fields).
- Web: card component tests (pending→answered, form persistence, failure
  revert), selector integration, `acp-session-chat` test that actually
  renders the component.
- e2e: extend `14-acp-harness-selector.spec.ts` contract; new
  permission-flow spec; perf trace spec (B5).
- Gates before any "done": `pnpm --filter @kortix/sdk typecheck && test &&
  smoke:install`; web `tsc` + suite; full-count check against baseline.

## Sequencing

1. **W0** pre-merge fixes → coordinate with Marko into #4510. Blocks nothing
   else.
2. **WA** SDK store branch (own worktree, Node 22 per repo law). Additive
   public API only; surface snapshot diff must show adds + deprecated aliases
   only.
3. **#4120 rebase** (re-split codemod strategy per the 2026-07-14 review) —
   independent of WA, before B4's tool-card touchpoints.
4. **WB** web UI branch on top of WA (+ #4120 for tool cards). B1–B3 don't
   collide with #4120's `tool/` split.
5. Follow-ups enabled but out of scope: mobile on-device polling
   verification, whitelabel #4470 rebase, v1 aliasing decision.

Constraint: nothing in this effort is committed or pushed without Jay's
explicit go-ahead, including this spec and the implementation plan.
