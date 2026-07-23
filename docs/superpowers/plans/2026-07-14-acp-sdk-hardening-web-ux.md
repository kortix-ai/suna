# ACP SDK Hardening + Web UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every correctness bug in the SDK ACP slice, restructure client state around a framework-free `AcpSession` store, and bring the ACP web surface to production quality (no stuck cards, no duplicate messages, no wedged sessions, ≤1 React commit per frame while streaming).

**Architecture:** Three sequential phases. W0: four minimal pre-merge fixes on `acp-harness-runtime-v2` for PR #4510. WA: a framework-free `AcpSession` store in `packages/sdk/src/acp/` with an incremental reducer, batching, and transport hardening; `useAcpSession` becomes a thin `useSyncExternalStore` wrapper with its existing contract preserved. WB: web UI on top — composer-integrated selector, memoized transcript rows, redesigned permission/question cards, session states, and CI-enforced perf budgets.

**Tech Stack:** TypeScript, bun test (co-located `*.test.ts`), React 18, `motion/react`, Tailwind + kortix design tokens, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-14-acp-sdk-hardening-web-ux-design.md` — read it before starting any task.

## Global Constraints

- **NEVER commit or push. Anywhere. Ever — unless Jay explicitly says so in the executing session.** Every task ends at a verification checkpoint, not a commit. This overrides the default TDD-commit cadence.
- SDK package law (`packages/sdk/CLAUDE.md`): TDD RED→GREEN→REFACTOR, failing test first, never weaken/skip a test; gates are `pnpm --filter @kortix/sdk typecheck`, `pnpm --filter @kortix/sdk test`, `pnpm --filter @kortix/sdk run smoke:install`; full-suite count must not drop below baseline (1069 tests / 71 files at plan time).
- Public API is additive-only: the `public-surface.snapshot.json` diff may show adds and `@deprecated` aliases, never removals/renames. `UPDATE_SURFACE_SNAPSHOT=1` only after confirming the diff is additive.
- `packages/sdk/src/acp/**` stays framework-free (isomorphic-core tier; the tripwire test enforces imports — also no bare `process`/`window` globals).
- Web UI: kortix-design-system tokens are law (`kortix-*` colors only, `rounded-md` panels, `Loading` never `Loader2`, `Hint` not `Tooltip`, `Modal` not `Dialog`, `errorToast`/`successToast` helpers). Motion: ease-out, UI durations <300ms, springs `{ type: 'spring', duration: 0.3, bounce: 0 }`, `AnimatePresence initial={false}`, no animation on keyboard-initiated actions, `prefers-reduced-motion` respected. Load skills `kortix-design-system` + `make-interfaces-feel-better` before any WB task.
- Worktrees: WA and WB happen in their own worktrees (`pnpm worktree start`, Node 22 via `nvm use 22`). W0 targets the `acp-harness-runtime-v2` checkout (coordinate with Marko before touching his branch).
- PROGRESS.md protocol: claim WA work in `packages/sdk/PROGRESS.md` (append to Discovered/Backlog, own session-log entry) before starting; but since committing is gated, keep the edit local and tell Jay.
- No code comments narrating changes; match neighboring file style.

---

## Phase W0 — pre-merge fixes for #4510 (branch `acp-harness-runtime-v2`)

### Task 1: CRLF-safe SSE framing in `consumeSse`

**Files:**
- Modify: `packages/sdk/src/acp/client.ts:261-290` (`consumeSse`)
- Test: `packages/sdk/src/acp/client.test.ts`

**Interfaces:**
- Consumes: existing `consumeSse(body, emit)` internal helper.
- Produces: unchanged signature; behavior now parses `\r\n` and lone-`\r` line endings per the SSE spec, including a CRLF split across chunk reads.

- [ ] **Step 1: Write the failing tests** (append to `client.test.ts`, matching its existing fake-fetch style):

```ts
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(chunks: string[]): Response {
  return new Response(streamOf(chunks), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('connect parses CRLF-delimited SSE events', async () => {
  const client = createAcpClient({
    endpoint: 'https://api.test/acp/s1',
    streamTransport: 'sse',
    fetch: (async () => sseResponse([
      'id: 1\r\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"a":1}}\r\n\r\n' +
      'id: 2\r\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"a":2}}\r\n\r\n',
    ])) as typeof fetch,
  });
  const events: number[] = [];
  await new Promise<void>((resolve) => {
    client.connect({
      reconnect: false,
      onEvent: (event) => { events.push(event.id); if (events.length === 2) resolve(); },
    });
  });
  expect(events).toEqual([1, 2]);
});

test('connect parses a CRLF boundary split across chunk reads', async () => {
  const client = createAcpClient({
    endpoint: 'https://api.test/acp/s1',
    streamTransport: 'sse',
    fetch: (async () => sseResponse([
      'id: 1\r\ndata: {"jsonrpc":"2.0","method":"m"}\r',       // trailing CR held back
      '\n\r\nid: 2\r\ndata: {"jsonrpc":"2.0","method":"m"}\r\n\r\n',
    ])) as typeof fetch,
  });
  const events: number[] = [];
  await new Promise<void>((resolve) => {
    client.connect({
      reconnect: false,
      onEvent: (event) => { events.push(event.id); if (events.length === 2) resolve(); },
    });
  });
  expect(events).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `pnpm --filter @kortix/sdk test src/acp/client.test.ts`
Expected: the two new tests FAIL (timeout or zero events — current code never finds `\n\n` in a CRLF stream).

- [ ] **Step 3: Implement.** Replace the body of `consumeSse` with:

```ts
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  emit: (event: AcpStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let holdback = '';
    if (!done && buffer.endsWith('\r')) {
      holdback = '\r';
      buffer = buffer.slice(0, -1);
    }
    buffer = buffer.replace(/\r\n|\r/g, '\n');
    // A finite test/server response may close immediately after the final
    // event's terminating newline instead of sending another blank line.
    if (done && buffer.trim()) buffer += '\n\n';
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let id: number | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('data:')) data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
      }
      if (id !== null && Number.isSafeInteger(id) && data.length) {
        emit({ id, envelope: JSON.parse(data.join('\n')) as AcpEnvelope });
      }
    }
    buffer += holdback;
    if (done) return;
  }
}
```

Note the two deliberate details: `\r\n|\r → \n` normalization happens before the boundary scan (with a trailing `\r` held back across reads, since it may be half of a split `\r\n`), and `data:` strips exactly one leading space per the SSE spec instead of `trimStart()`.

- [ ] **Step 4: Run the full client suite**

Run: `pnpm --filter @kortix/sdk test src/acp/client.test.ts`
Expected: all tests PASS (existing LF tests must still pass).

- [ ] **Step 5: Checkpoint — do NOT commit.** Report gate output to Jay.

### Task 2: honor `reconnect: false` on the SSE error path

**Files:**
- Modify: `packages/sdk/src/acp/client.ts:175-181` (catch block in `connect`'s `run`)
- Test: `packages/sdk/src/acp/client.test.ts`

**Interfaces:**
- Consumes: `AcpClient.connect(options)` with `reconnect?: boolean`.
- Produces: `reconnect: false` guarantees at most one fetch attempt, success or failure — parity with the poll path (`client.ts:228,232`).

- [ ] **Step 1: Write the failing test**

```ts
test('connect with reconnect:false stops after a failed fetch', async () => {
  let calls = 0;
  const client = createAcpClient({
    endpoint: 'https://api.test/acp/s1',
    streamTransport: 'sse',
    fetch: (async () => { calls += 1; return new Response('nope', { status: 500 }); }) as typeof fetch,
  });
  const errors: unknown[] = [];
  client.connect({ reconnect: false, onEvent: () => {}, onError: (e) => errors.push(e) });
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(calls).toBe(1);
  expect(errors.length).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kortix/sdk test src/acp/client.test.ts`
Expected: FAIL — `calls` is ≥2 (the loop retries after ~250ms backoff).

- [ ] **Step 3: Implement.** In the catch block of `run`:

```ts
        } catch (error) {
          if (closed || controller.signal.aborted) return;
          options.onError?.(error);
          if (options.reconnect === false) return;
        }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @kortix/sdk test src/acp/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 3: optimistic response echo — permission/question cards clear immediately

**Files:**
- Modify: `packages/sdk/src/react/use-acp-session.ts:98-100`
- Test: `packages/sdk/src/react/use-acp-session.test.tsx` (new — match the harness of the neighboring `react/*.test.tsx` files; the assertions below are the contract)

**Interfaces:**
- Consumes: `AcpClient.respond(id, result)`, `projectAcpPendingPrompts(rows)` (its answered-set scan at `transcript.ts:313-319` has no direction filter, so a locally-appended `client_to_agent` response row clears the pending entry).
- Produces: `respondPermission(id, optionId?)`, `respondQuestion(id, content)`, `rejectQuestion(id)` — same signatures, now `Promise<void>` that appends `{ jsonrpc: '2.0', id, result }` to `envelopes` after a successful POST.

- [ ] **Step 1: Write the failing test**

```tsx
test('respondPermission clears the pending permission without a reload', async () => {
  const permissionRequest = {
    ordinal: 5, direction: 'agent_to_client' as const, streamEventId: 5,
    envelope: { jsonrpc: '2.0' as const, id: 9, method: 'session/request_permission',
      params: { sessionId: 's1', options: [{ optionId: 'allow', label: 'Allow' }] } },
    createdAt: '2026-07-14T00:00:00Z',
  };
  const fetchMock = makeAcpFetchMock({ transcript: [permissionRequest] }); // shared helper: serves /transcript, 202s POSTs, stubs initialize/session-new
  const { result } = renderHook(() => useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: 'acp-1' }));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(projectAcpPendingPrompts(result.current.envelopes).permissions).toHaveLength(1);
  await act(() => result.current.respondPermission(9, 'allow'));
  expect(projectAcpPendingPrompts(result.current.envelopes).permissions).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails** — pending list still has length 1 after responding.

- [ ] **Step 3: Implement.** Replace the three callbacks:

```ts
  const respondWithEcho = useCallback(async (id: AcpJsonRpcId, result: unknown) => {
    await client.respond(id, result);
    addEnvelope({
      ordinal: Date.now() * 1000,
      direction: 'client_to_agent',
      streamEventId: null,
      envelope: { jsonrpc: '2.0', id, result },
    });
  }, [addEnvelope, client]);
  const respondPermission = useCallback((id: AcpJsonRpcId, optionId?: string) =>
    respondWithEcho(id, { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }), [respondWithEcho]);
  const respondQuestion = useCallback((id: AcpJsonRpcId, content: Record<string, unknown>) =>
    respondWithEcho(id, { action: 'accept', content }), [respondWithEcho]);
  const rejectQuestion = useCallback((id: AcpJsonRpcId) =>
    respondWithEcho(id, { action: 'decline' }), [respondWithEcho]);
```

- [ ] **Step 4: Run to verify it passes**, then the whole react dir: `pnpm --filter @kortix/sdk test src/react`.

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 4: stop re-minting `session/new` on effect re-runs

**Files:**
- Modify: `packages/sdk/src/react/use-acp-session.ts:58-67`
- Test: `packages/sdk/src/react/use-acp-session.test.tsx`

**Interfaces:**
- Produces: at most one `session/new` per hook instance lifetime; re-runs `session/load` the previously created id.

- [ ] **Step 1: Write the failing test**

```tsx
test('StrictMode double-mount creates exactly one ACP session', async () => {
  const fetchMock = makeAcpFetchMock({ transcript: [] });
  const { result } = renderHook(
    () => useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: null }),
    { wrapper: StrictMode },
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(fetchMock.calls('session/new')).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails** — two `session/new` calls today.

- [ ] **Step 3: Implement.** Add a ref and consult it:

```ts
  const createdSessionIdRef = useRef<string | null>(null);
  // inside the effect's async bootstrap:
        let id = runtimeSessionId ?? createdSessionIdRef.current;
        if (id) {
          const loaded = await client.loadSession({ sessionId: id, cwd: '/workspace', mcpServers: [] });
          if (active) setConfigOptions(loaded.configOptions ?? []);
        } else {
          const created = await client.newSession({ cwd: '/workspace', mcpServers: [] });
          if (!created.sessionId) throw new Error('ACP session/new returned no sessionId');
          id = created.sessionId;
          createdSessionIdRef.current = id;
          if (active) setConfigOptions(created.configOptions ?? []);
        }
```

(Import `useRef` from react. The proper single-flight fix is WA Task 6; this is the minimal pre-merge guard.)

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Phase gate.** Run all three SDK gates. Report output + surface-snapshot status to Jay. **Do NOT commit** — Jay coordinates handing W0 to Marko/#4510.

---

## Phase WA — framework-free `AcpSession` store (own worktree, post-merge)

### Task 5: `AcpSession` skeleton — lifecycle, subscribe, batching

**Files:**
- Create: `packages/sdk/src/acp/session.ts`
- Create: `packages/sdk/src/acp/session.test.ts`
- Modify: `packages/sdk/src/acp/index.ts` (add `export * from './session';`)

**Interfaces:**
- Consumes: `AcpClient` (`connect`, `initialize`, `newSession`, `loadSession`, `prompt`, `respond`, `cancel`, `setSessionConfigOption`, `transcript`), types from `./types` and `./transcript`.
- Produces (later tasks and the react wrapper depend on these exact names):

```ts
export type AcpConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';
export type AcpSessionError = { kind: 'transport' | 'rpc' | 'bootstrap'; message: string; status?: number; code?: number; terminal: boolean };
export type AcpSessionSnapshot = {
  envelopes: readonly AcpStoredEnvelope[];
  chatItems: readonly AcpChatItem[];
  pendingPrompts: AcpPendingPrompts;
  usage: AcpUsageProjection | null;
  turnState: AcpTurnState;
  connection: AcpConnectionState;
  ready: boolean;
  busy: boolean;
  error: AcpSessionError | null;
  acpSessionId: string | null;
  configOptions: AcpSessionConfigOption[];
  capabilities: Record<string, unknown>;
  agentInfo: NonNullable<AcpInitializeResult['agentInfo']> | null;
  authMethods: Array<Record<string, unknown>>;
};
export type AcpSessionOptions = {
  endpoint: string;
  acpSessionId?: string | null;
  cwd?: string;                       // default '/workspace'
  protocolVersion?: number;           // default 1
  clientInfo?: { name: string; title?: string; version: string };
  clientCapabilities?: Record<string, unknown>;
  fetch?: typeof fetch;
  streamTransport?: 'auto' | 'sse' | 'poll';
  scheduleFlush?: (flush: () => void) => void;  // default: queueMicrotask; tests inject sync
};
export class AcpSession {
  constructor(options: AcpSessionOptions);
  connect(): void;
  close(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): AcpSessionSnapshot;
  send(prompt: AcpContentBlock[]): Promise<boolean>;
  cancel(): Promise<void>;
  respondPermission(id: AcpJsonRpcId, optionId?: string): Promise<void>;
  respondQuestion(id: AcpJsonRpcId, content: Record<string, unknown>): Promise<void>;
  rejectQuestion(id: AcpJsonRpcId): Promise<void>;
  setConfigOption(configId: string, value: unknown): Promise<boolean>;
}
export function createAcpSession(options: AcpSessionOptions): AcpSession;
```

- [ ] **Step 1: Write the failing tests** (`session.test.ts`; reuse `streamOf`/`sseResponse` helpers — extract them into `packages/sdk/src/acp/test-helpers.ts` if `client.test.ts` hasn't already):

```ts
test('connect is idempotent — one stream, one bootstrap', async () => {
  const fetchMock = makeSessionFetchMock();   // counts SSE GETs, initialize, session/new
  const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });
  session.connect();
  session.connect();
  await waitUntil(() => session.getSnapshot().ready);
  expect(fetchMock.sseConnections).toBe(1);
  expect(fetchMock.calls('initialize')).toHaveLength(1);
  expect(fetchMock.calls('session/new')).toHaveLength(1);
});

test('getSnapshot identity is stable between emissions and changes after one', async () => {
  const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });
  session.connect();
  await waitUntil(() => session.getSnapshot().ready);
  const a = session.getSnapshot();
  expect(session.getSnapshot()).toBe(a);
  await fetchMock.emitSse([chunkEnvelope(1, 'x')]);
  expect(session.getSnapshot()).not.toBe(a);
});

test('events in one flush window coalesce into a single emission', async () => {
  let flush: (() => void) | null = null;
  const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => { flush = f; } });
  let notifications = 0;
  session.subscribe(() => { notifications += 1; });
  session.connect();
  await fetchMock.emitSse([chunkEnvelope(1, 'a'), chunkEnvelope(2, 'b'), chunkEnvelope(3, 'c')]);
  flush!();
  expect(notifications).toBe(1);
  expect(session.getSnapshot().envelopes).toHaveLength(3);
});

test('close() aborts the stream and further events are ignored', async () => {
  const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });
  session.connect();
  await waitUntil(() => session.getSnapshot().connection === 'open');
  session.close();
  expect(fetchMock.lastSseAborted).toBe(true);
  await fetchMock.emitSse([chunkEnvelope(1, 'late')]);
  expect(session.getSnapshot().envelopes).toHaveLength(0);
  expect(session.getSnapshot().connection).toBe('closed');
});
```

- [ ] **Step 2: Run to verify they fail** (module doesn't exist): `pnpm --filter @kortix/sdk test src/acp/session.test.ts` → import error.

- [ ] **Step 3: Implement the skeleton.** Core shape (reducer integration arrives in Task 6 — for now `chatItems`/`pendingPrompts`/`usage`/`turnState` are recomputed from `projectAcp*` at flush time, which the parity tests in Task 6 then replace):

```ts
export class AcpSession {
  private client: AcpClient;
  private listeners = new Set<() => void>();
  private snapshot: AcpSessionSnapshot = EMPTY_SNAPSHOT;
  private pendingEnvelopes: AcpStoredEnvelope[] = [];
  private flushScheduled = false;
  private stream: AcpStreamHandle | null = null;
  private bootstrap: Promise<void> | null = null;
  private createdSessionId: string | null = null;
  private readonly scheduleFlush: (flush: () => void) => void;

  constructor(private readonly options: AcpSessionOptions) {
    this.client = createAcpClient({ endpoint: options.endpoint, fetch: options.fetch, streamTransport: options.streamTransport });
    this.scheduleFlush = options.scheduleFlush ?? ((f) => queueMicrotask(f));
    this.snapshot = { ...EMPTY_SNAPSHOT, acpSessionId: options.acpSessionId ?? null };
  }

  connect(): void {
    if (this.stream) return;
    this.setConnection('connecting');
    this.stream = this.client.connect({
      onEvent: (event) => this.enqueue({
        ordinal: syntheticOrdinal(event.id),
        direction: 'agent_to_client',
        streamEventId: event.id,
        envelope: event.envelope,
      }),
      onError: (error) => this.onStreamError(error),
    });
    this.bootstrap ??= this.runBootstrap();
  }

  private async runBootstrap(): Promise<void> {
    try {
      const history = await this.client.transcript();
      this.enqueueHistory(history.envelopes);
      const initialized = await this.client.initialize({
        protocolVersion: this.options.protocolVersion ?? 1,
        clientCapabilities: this.options.clientCapabilities ?? { auth: { _meta: { gateway: true } } },
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      });
      let id = this.options.acpSessionId ?? this.createdSessionId;
      const result = id
        ? await this.client.loadSession({ sessionId: id, cwd: this.cwd(), mcpServers: [] })
        : await this.client.newSession({ cwd: this.cwd(), mcpServers: [] });
      if (!id) {
        if (!result.sessionId) throw new Error('ACP session/new returned no sessionId');
        id = result.sessionId;
        this.createdSessionId = id;
      }
      this.patch({ ready: true, acpSessionId: id, configOptions: result.configOptions ?? [],
        capabilities: initialized.agentCapabilities ?? {}, agentInfo: initialized.agentInfo ?? null,
        authMethods: initialized.authMethods ?? [] });
    } catch (error) {
      this.patch({ error: toSessionError('bootstrap', error) });
      this.bootstrap = null;      // allow retry on next connect()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getSnapshot(): AcpSessionSnapshot { return this.snapshot; }

  private enqueue(row: AcpStoredEnvelope): void {
    this.pendingEnvelopes.push(row);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.scheduleFlush(() => this.flush());
  }
  private flush(): void {
    this.flushScheduled = false;
    if (!this.pendingEnvelopes.length) return;
    const batch = this.pendingEnvelopes;
    this.pendingEnvelopes = [];
    this.applyBatch(batch);   // Task 6 makes this incremental
    this.emit();
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private patch(partial: Partial<AcpSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.emit();
  }
  close(): void {
    this.stream?.close();
    this.stream = null;
    this.setConnection('closed');
  }
  // send/cancel/respond*/setConfigOption port the hook's logic verbatim,
  // with optimistic echoes via this.enqueue (respond echo = W0 Task 3 semantics).
}
```

- [ ] **Step 4: Run to verify tests pass**: `pnpm --filter @kortix/sdk test src/acp/session.test.ts`.

- [ ] **Step 5: Wire exports.** `index.ts` barrel already `export *`s; run `UPDATE_SURFACE_SNAPSHOT=1 pnpm --filter @kortix/sdk test src/public-surface` and verify the diff is **adds only**.

- [ ] **Step 6: Checkpoint — do NOT commit.**

### Task 6: incremental reducer with structural sharing

**Files:**
- Create: `packages/sdk/src/acp/reduce.ts`
- Create: `packages/sdk/src/acp/reduce.test.ts`
- Modify: `packages/sdk/src/acp/session.ts` (`applyBatch` uses the reducer)
- Modify: `packages/sdk/src/acp/transcript.ts` (`projectAcpChatItems`/`projectAcpPendingPrompts`/`projectAcpUsage`/`projectAcpTurnState` become fold-from-scratch wrappers over the same step function — one implementation, two entry points)

**Interfaces:**
- Produces:

```ts
export type AcpReducerState = {
  envelopes: AcpStoredEnvelope[];
  chatItems: AcpChatItem[];
  toolIndex: Map<string, number>;          // toolCallId -> chatItems index
  answeredIds: Set<string>;                // rpcIdKey(id)
  openRequests: Map<string, AcpChatItem>;  // pending permission/question by rpcIdKey
  usage: AcpUsageProjection | null;
  turnState: AcpTurnState;
};
export function emptyReducerState(): AcpReducerState;
export function reduceEnvelope(state: AcpReducerState, row: AcpStoredEnvelope): AcpReducerState;
// Mutates nothing: returns a new state object; chatItems is copied shallowly and
// ONLY the touched item gets new identity. Untouched items are reference-equal.
export function pendingFromState(state: AcpReducerState): AcpPendingPrompts;
```

- [ ] **Step 1: Write the failing tests.** The two load-bearing properties:

```ts
test('incremental reduce matches from-scratch projection on a recorded session', () => {
  const rows = loadFixture('acp-session-mixed.json'); // ~50 rows: prompts, chunks, tool_call(+update), plan, permission, responses, usage_update
  let state = emptyReducerState();
  for (const row of rows) state = reduceEnvelope(state, row);
  expect(state.chatItems).toEqual(projectAcpChatItems(rows));
  expect(pendingFromState(state)).toEqual(projectAcpPendingPrompts(rows));
  expect(state.usage).toEqual(projectAcpUsage(rows));
  expect(state.turnState).toEqual(projectAcpTurnState(rows));
});

test('a message chunk gives new identity only to the tail item', () => {
  let state = emptyReducerState();
  state = reduceEnvelope(state, userPrompt(1));
  state = reduceEnvelope(state, agentChunk(2, 'hel'));
  const before = state.chatItems;
  state = reduceEnvelope(state, agentChunk(3, 'lo'));
  expect(state.chatItems[0]).toBe(before[0]);          // untouched user message: same ref
  expect(state.chatItems[1]).not.toBe(before[1]);      // appended-to assistant message: new ref
  expect((state.chatItems[1] as { text: string }).text).toBe('hello');
});

test('tool_call_update before tool_call still produces one tool item', () => { /* update arrives first; then tool_call merges into it */ });
test('a duplicate streamEventId row is dropped', () => { /* dedupe lives in the reducer now */ });
```

Create the fixture at `packages/sdk/src/acp/__fixtures__/acp-session-mixed.json` by hand from the shapes in `transcript.test.ts` (do not record from a live session for this unit fixture).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `reduceEnvelope`.** Port the branch logic of `projectAcpChatItems` (transcript.ts:123-181) case-by-case into a single-row step; replace `items.find(...)` for tools with `toolIndex` lookups; maintain `answeredIds`/`openRequests` as rows arrive (a response row deletes from `openRequests`); message-chunk coalescing replaces `previous.text +=` mutation with `chatItems[last] = { ...previous, text: previous.text + text }`. Rewrite the four `projectAcp*` functions as `rows.reduce(reduceEnvelope, emptyReducerState())` + selector — their existing tests in `transcript.test.ts` are the regression harness and must pass unchanged.

- [ ] **Step 4: Point `AcpSession.applyBatch` at the reducer** and derive `busy` as `turnState.busy || requestBusy`.

- [ ] **Step 5: Run the full SDK suite** — `transcript.test.ts` unchanged and green is the acceptance bar.

- [ ] **Step 6: Checkpoint — do NOT commit.**

### Task 7: explicit method table + reducer correctness fixes

**Files:**
- Modify: `packages/sdk/src/acp/transcript.ts:158-168, 296-309, 463-469` (+ types at 3-9, 30-36)
- Test: `packages/sdk/src/acp/transcript.test.ts`

**Interfaces:**
- Produces:

```ts
export type AcpMethodKind = 'permission' | 'question' | 'raw';
export type AcpMethodClassifier = (method: string) => AcpMethodKind;
export const classifyAcpMethod: AcpMethodClassifier;  // exact-match table below
// projectAcpChatItems / projectAcpPendingPrompts gain an optional
// { classifyMethod?: AcpMethodClassifier } options argument (default classifyAcpMethod).
```

- [ ] **Step 1: Write the failing tests**

```ts
test('classifyAcpMethod is an exact table, not substring sniffing', () => {
  expect(classifyAcpMethod('session/request_permission')).toBe('permission');
  expect(classifyAcpMethod('elicitation/create')).toBe('question');
  expect(classifyAcpMethod('session/request')).toBe('raw');       // 'request' substring must NOT match
  expect(classifyAcpMethod('fs/read_text_file')).toBe('raw');
  expect(classifyAcpMethod('terminal/create')).toBe('raw');
});
test('tool status never regresses from a terminal state', () => {
  const rows = [toolCall('t1', 'completed'), toolCallUpdate('t1', 'in_progress')];
  const [tool] = projectAcpChatItems(rows).filter((item) => item.kind === 'tool');
  expect(tool.status).toBe('completed');
});
test('a plan after a new user prompt starts a new plan item', () => {
  const rows = [userPrompt(1), plan(2, ['a']), userPrompt(3), plan(4, ['b'])];
  expect(projectAcpChatItems(rows).filter((item) => item.kind === 'plan')).toHaveLength(2);
});
test('usage_update, current_mode_update, available_commands_update do not become chat items', () => {
  const rows = [sessionUpdate(1, { sessionUpdate: 'usage_update', used: 10, size: 100 })];
  expect(projectAcpChatItems(rows)).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify they fail** (substring matcher classifies `session/request` as question; status regresses; plan is a singleton; usage_update renders raw).

- [ ] **Step 3: Implement.**

```ts
const METHOD_KINDS: Record<string, AcpMethodKind> = {
  'session/request_permission': 'permission',
  'elicitation/create': 'question',
  'elicitation/request': 'question',
  'session/request_input': 'question',
};
export const classifyAcpMethod: AcpMethodClassifier = (method) => METHOD_KINDS[method] ?? 'raw';

const NON_VISUAL_UPDATES = new Set(['usage_update', 'current_mode_update', 'available_commands_update']);
const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled']);
// mergeToolCall: status: TERMINAL_TOOL_STATUSES.has(previous.status ?? '') && !TERMINAL_TOOL_STATUSES.has(next.status ?? '') ? previous.status : next.status ?? previous.status
// plan branch: find the last plan item AFTER the last user message instead of items.find(kind === 'plan')
```

Keep `isPermissionMethod`/`isQuestionMethod` as `@deprecated` exported wrappers over the table (published API — alias, never remove). Type hygiene in the same pass: `AcpStoredEnvelope.direction` narrows to `'client_to_agent' | 'agent_to_client'`; add `export type AcpTranscriptRow` for `transcript()`'s row and re-type its return; `react/use-acp-session.ts`'s `AcpStoredSessionEnvelope` becomes `/** @deprecated */ export type AcpStoredSessionEnvelope = AcpTranscriptRow;`.

- [ ] **Step 4: Full suite + surface snapshot** (adds + deprecations only).

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 8: transport taxonomy, backoff, connection state

**Files:**
- Modify: `packages/sdk/src/acp/client.ts` (`connect`, `post`, new error class), `packages/sdk/src/acp/types.ts`
- Modify: `packages/sdk/src/acp/session.ts` (map `onState` into snapshot `connection`, auto-clear transient errors)
- Test: `packages/sdk/src/acp/client.test.ts`, `session.test.ts`

**Interfaces:**
- Produces:

```ts
export class AcpTransportError extends Error {
  constructor(message: string, readonly status: number, readonly terminal: boolean);
}
// connect(options) gains: onState?(state: AcpConnectionState): void
// Terminal = status in 400..499 excluding 408 and 429. Terminal → onState('failed'), loop exits.
// retryMs resets to 250 only after the first event of a connection; jitter = retryMs * (0.85 + Math.random() * 0.3).
```

- [ ] **Step 1: Failing tests:** 403 → exactly one fetch, `onState` sequence `['connecting','failed']`; 500 → retries with `onState` `['connecting','reconnecting', ...]`; backoff does not reset when a connection dies before any event (assert second retry delay > first via injected `setTimeout` spy or fake timers); non-OK POST throws `AcpTransportError` with `status`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** in `connect`'s loop: throw `new AcpTransportError(..., response.status, isTerminalStatus(response.status))` on non-OK; in catch, `if (error instanceof AcpTransportError && error.terminal) { options.onState?.('failed'); return; }`; move `retryMs = 250` from post-fetch (line 168) into the first `onEvent` delivery; apply jitter to the delay. `post()` throws `AcpTransportError` instead of bare `Error`. In `AcpSession`: `onState` patches `connection`; entering `'open'` clears `error` when `error.kind === 'transport'`.

- [ ] **Step 4: Full SDK suite.**

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 9: id integrity, poll replay seed, daemon `?agent=`, abort hygiene, SSE leftovers

**Files:**
- Modify: `packages/sdk/src/acp/client.ts` (`nextId`→string ids, `request`, `pollTranscript`, `transcript`, constructor, `connect` listeners, `consumeSse`)
- Modify: `packages/sdk/src/acp/transcript.ts` (ordinal-ordering backstop in `projectAcpTurnState`/`projectAcpPendingPrompts`)
- Test: `packages/sdk/src/acp/client.test.ts`, `transcript.test.ts`

**Interfaces:**
- Produces: request ids are strings `` `${Date.now()}-${counter}` ``; `request()` rejects a response whose `id` mismatches; `AcpClientOptions` gains `agent?: string` (appended as `?agent=` on POST in `baseUrl+serverId` mode); `transcript(after?, signal?)`; `connect` respects an already-aborted `options.signal` and removes its abort listener on close; `id: 0` SSE events are delivered; a parse-failing event with a valid id advances `lastEventId` and reports via `onError` instead of poisoning replay.

- [ ] **Step 1: Failing tests** (one per behavior):

```ts
test('two clients never produce colliding request ids', () => { /* create 2 clients, issue requests, collect posted ids, assert Set size === count */ });
test('request() rejects a mismatched response id', async () => { /* fetch returns {id: 'other', result: 1} → rejects */ });
test('poll transport resumes from lastEventId', async () => { /* connect({lastEventId: 5}) in poll mode → first transcript URL contains ?after= mapped from seeded progress; rows with streamEventId <= 5 are not re-emitted */ });
test('daemon mode appends ?agent= on POST', async () => { /* createAcpClient({baseUrl, serverId, agent: 'claude'}) → post URL ends /acp/s1?agent=claude */ });
test('connect with an already-aborted signal never fetches', async () => { /* AbortController aborted before connect → 0 fetches */ });
test('an id:0 event is delivered', async () => { /* stream 'id: 0\ndata: {...}' → onEvent called */ });
test('a poison event is skipped, later events still arrive', async () => { /* id:1 invalid JSON, id:2 valid → onError once, onEvent id 2, no refetch loop */ });
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** `private nextId = 0; private readonly idPrefix = String(Date.now());` → `` const id = `${this.idPrefix}-${++this.nextId}` ``. Track `lastEventId` as `number | null` (null = none; header sent only when non-null; dedupe check `event.id <= lastEventId` becomes `lastEventId !== null && event.id <= lastEventId`). Wrap the per-event emit in try/catch: advance `lastEventId` first, then `JSON.parse`; on failure call `options.onError?.(error)` and continue. Ordinal backstop in `projectAcpTurnState`: a response only answers the **nearest preceding** request row with the same id (track request ordinals in a map id→ordinal; a response row answers ids whose request ordinal < response ordinal and clears the map entry).

- [ ] **Step 4: Full SDK suite.**

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 10: busy-staleness policy

**Files:**
- Modify: `packages/sdk/src/acp/transcript.ts` (`projectAcpTurnState`), `packages/sdk/src/acp/session.ts` (`send` override)
- Test: `packages/sdk/src/acp/transcript.test.ts`, `session.test.ts`

**Interfaces:**
- Produces: a pending `session/prompt` stops counting toward `busy` when (a) a later `session/cancel` for the same `sessionId` exists in the log, or (b) a later `session/prompt` supersedes it. `AcpSession.send()` never refuses on persisted-only busy (only on live `requestBusy`).

- [ ] **Step 1: Failing tests**

```ts
test('a cancel notification after a pending prompt clears busy', () => {
  const rows = [promptRow(1, 'req-1'), cancelRow(2)];
  expect(projectAcpTurnState(rows).busy).toBe(false);
});
test('a newer prompt supersedes an orphaned pending prompt', () => {
  const rows = [promptRow(1, 'req-1'), promptRow(3, 'req-2'), responseRow(4, 'req-2')];
  expect(projectAcpTurnState(rows)).toEqual({ busy: false, pendingPromptIds: [] });
});
test('send() proceeds when busy comes only from persisted state', async () => { /* seed transcript with an orphaned prompt; session.send resolves true and POSTs */ });
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** in `projectAcpTurnState`: while scanning `client_to_agent` rows, a `session/cancel` marks all earlier unanswered prompt ids stale; a `session/prompt` marks all earlier unanswered prompt ids stale. In `AcpSession.send`: guard is `if (!this.snapshot.acpSessionId || this.requestBusy) return false;`.

- [ ] **Step 4: Full SDK suite.**  

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 11: optimistic-echo reconciliation by ordinal

**Files:**
- Modify: `packages/sdk/src/acp/session.ts` (history merge + local-row reconciliation), `packages/sdk/src/acp/reduce.ts` if dedupe key lives there
- Test: `packages/sdk/src/acp/session.test.ts`

**Interfaces:**
- Produces: history rows merge by server `ordinal` (authoritative); a local optimistic row (synthetic ordinal, `streamEventId: null`) is replaced when a server row for the same JSON-RPC id + direction arrives; re-running the history fetch is idempotent (no duplicate user bubbles — the `use-acp-session.ts:48-51` bug class).

- [ ] **Step 1: Failing tests:** (a) bootstrap twice against the same transcript → `envelopes` length unchanged; (b) optimistic prompt echo followed by the server's persisted prompt row with the same id → one chat item, server ordinal wins; (c) optimistic respond echo followed by server response row → one answered entry.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement:** history merge keys rows by `ordinal` (a `Map<number, AcpStoredEnvelope>`); local rows key by `local:${direction}:${rpcIdKey(envelope.id)}` and are dropped when a server row with the same id+direction lands. Reducer state rebuilds from scratch on history merge (rare event), stays incremental on live events.

- [ ] **Step 4: Full SDK suite.**

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 12: lossless transcript exports over stored envelopes

**Files:**
- Modify: `packages/sdk/src/acp/transcript.ts:624-658`
- Test: `packages/sdk/src/acp/transcript.test.ts`

**Interfaces:**
- Produces:

```ts
export function acpTranscriptJsonl(rows: readonly AcpStoredEnvelope[]): string;
// emits {ordinal, direction, streamEventId, createdAt, envelope} per line — round-trips losslessly
export function acpTranscriptMarkdown(rows: readonly AcpStoredEnvelope[]): string;
// coalesces chunks via projectAcpChatItems: one section per message/tool/plan, not per chunk
export function acpTranscriptHtml(rows: readonly AcpStoredEnvelope[]): string;
```

Old `AcpStreamEvent[]` call shapes keep working via a runtime input check (`'envelope' in first && 'id' in first && !('ordinal' in first)`) mapped through a `@deprecated` documented adapter — published API, alias-never-replace.

- [ ] **Step 1: Failing tests:** JSONL round-trip (`parse(lines) → same rows`); markdown of a 3-chunk assistant reply contains the joined text exactly once and no `agent_message_chunk` heading; client→agent prompt rows appear in JSONL.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** per the interface block. Markdown: build from `projectAcpChatItems(rows)` — `## user` / `## assistant` / `## thought` sections with text, `## tool: {title} ({status})` with fenced JSON, `## plan` with entries.

- [ ] **Step 4: Full SDK suite + surface snapshot.**

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 13: tool-part normalization + elicitation coercion into the SDK

**Files:**
- Create: `packages/sdk/src/acp/tool-part.ts`, `packages/sdk/src/acp/tool-part.test.ts`
- Modify: `packages/sdk/src/acp/transcript.ts` (coercion helper next to `questionItemsFromSchema`)
- Modify: `apps/web/src/features/session/acp-tool-call-card.tsx` (delete local logic, import from SDK)
- Test: `apps/web/src/features/session/acp-tool-call-card.test.tsx` keeps passing against the SDK import

**Interfaces:**
- Produces:

```ts
export type AcpNormalizedToolPart = {
  id: string; callID: string; tool: string;   // 'bash' | 'edit' | 'read' | ... | 'acp_tool'
  state: { status: 'pending' | 'running' | 'completed' | 'error';
           input: Record<string, unknown>; output: string; error?: string;
           metadata: { locations: unknown[]; acp: Record<string, unknown> } };
};
export function acpToolCallToPart(tool: AcpToolCall): AcpNormalizedToolPart;
export function acpToolName(tool: AcpToolCall): string;
export function coerceElicitationAnswers(
  answers: Record<string, string>,
  params: Record<string, unknown>,           // reads params.requestedSchema.properties[key].type
): Record<string, unknown>;                  // 'true'→true, '42'→42 for boolean/number/integer props
```

- [ ] **Step 1: Failing tests:** port the regex-mapping cases from `acp-tool-call-card.tsx:37-49` verbatim into `tool-part.test.ts` (execute/terminal→bash, apply patch→apply_patch, write/edit/read/glob/grep/webfetch, fallback `acp_tool`, string input → `{command}` for bash / `{value}` otherwise, location path → `{filePath}`); coercion: boolean/number/integer/string/enum passthrough.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** by moving the functions from the web file (dropping `sessionID`/`messageID`/`as ToolPart` — the web adapter adds host fields). Web file shrinks to:

```tsx
import { acpToolCallToPart, type AcpPlan, type AcpToolCall } from '@kortix/sdk';

export function AcpToolCallCard({ tool, sessionId, compact = false }: { tool: AcpToolCall; sessionId: string; compact?: boolean }) {
  const normalized = acpToolCallToPart(tool);
  const part = { ...normalized, type: 'tool', sessionID: sessionId, messageID: `acp-tool-message:${tool.id}` } as ToolPart;
  return <ToolPartRenderer part={part} sessionId={sessionId} defaultOpen={!compact && part.state.status === 'error'} />;
}
```

- [ ] **Step 4: SDK suite + web suite (`pnpm --filter web test src/features/session`), surface snapshot additive.**

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 14: `useAcpSession` becomes a `useSyncExternalStore` wrapper

**Files:**
- Modify: `packages/sdk/src/react/use-acp-session.ts` (full rewrite over `AcpSession`)
- Modify: `packages/sdk/src/version.ts` (or create — build-stamped `SDK_VERSION` constant; `stage-npm-publish.mjs` already rewrites `package.json`, add a sed-style rewrite of this constant to the staging script and assert it in `stage-npm-publish.test.mjs`)
- Test: `packages/sdk/src/react/use-acp-session.test.tsx` (extends W0 Task 3/4 file)

**Interfaces:**
- Consumes: `createAcpSession`, `AcpSessionSnapshot` (Task 5), `projectAcpEndpoint`.
- Produces: the hook's **existing return contract unchanged** plus additive fields:

```ts
return {
  ready, busy, error,                    // error: string | null (derived from snapshot.error?.message — unchanged shape)
  envelopes, configOptions, capabilities, agentInfo, authMethods,
  send, cancel, setConfigOption, respondPermission, respondQuestion, rejectQuestion,
  acpSessionId,                          // NEW
  connection,                            // NEW: AcpConnectionState
  errorInfo,                             // NEW: AcpSessionError | null (structured)
  /** @deprecated use acpSessionId */
  runtimeSessionId: acpSessionId,
};
```

- [ ] **Step 1: Failing tests:** StrictMode double-mount → one `session/new` AND zero duplicate envelopes (tightens Task 4); unmount closes the stream (fetch abort observed); snapshot identity stable across renders with no events; `enabled: false → true` toggle reuses the created session; start-stash replay still fires once.

- [ ] **Step 2: Run to verify they fail** against the current implementation (duplicate-envelope assertion fails pre-Task-11 semantics in the hook).

- [ ] **Step 3: Implement:**

```ts
export function useAcpSession({ projectId, sessionId, runtimeSessionId, enabled = true, replayStartStash = true }: { /* unchanged */ }) {
  const session = useMemo(() => createAcpSession({
    endpoint: projectAcpEndpoint(projectId, sessionId),
    acpSessionId: runtimeSessionId ?? null,
    clientInfo: { name: '@kortix/sdk', title: 'Kortix SDK', version: SDK_VERSION },
  }), [projectId, sessionId, runtimeSessionId]);
  useEffect(() => {
    if (!enabled) return;
    session.connect();
    return () => session.close();     // close() is re-connectable: StrictMode remount calls connect() again, the single-flight bootstrap holds
  }, [enabled, session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  // start-stash replay: one effect gated on snapshot.ready + a ref, calls session.send
  return { ...selectHookApi(snapshot, session) };
}
```

(`close()` must therefore preserve `bootstrap`/`createdSessionId` and only tear down the stream — verify Task 5's implementation does; adjust if not.)

- [ ] **Step 4: Full SDK gates** (`typecheck` + `test` + `smoke:install`) and full-count check vs baseline.

- [ ] **Step 5: Phase gate.** Surface snapshot diff review (adds + deprecations only). Report to Jay. **Do NOT commit.**

---

## Phase WB — web UI/UX (own worktree, after WA; load `kortix-design-system` + `make-interfaces-feel-better` skills first)

### Task 15: composer-integrated selector; delete the config bar

**Files:**
- Modify: `apps/web/src/features/session/acp-session-chat.tsx:119-133` (delete the `Select` bar), pass `configOptions`/`setConfigOption` down to `SessionChatInput`
- Modify: `apps/web/src/features/session/session-chat-input.tsx` (accept `acpConfigOptions`, `onAcpConfigOption`; route model-typed options into the existing selector slot, mode-typed into `TabsListCompact`, rest into an overflow popover)
- Modify: `apps/web/src/features/session/header/session-site-header.tsx` (harness `Badge`)
- Test: `apps/web/src/features/session/acp-config-controls.test.tsx` (new), e2e `tests/e2e/specs/14-acp-harness-selector.spec.ts` must stay green

**Interfaces:**
- Consumes: `configOptions: AcpSessionConfigOption[]`, `setConfigOption(configId, value): Promise<boolean>`, `agentInfo` from the hook.
- Produces: `<AcpConfigControls options onChange />` component (new file `apps/web/src/features/session/acp-config-controls.tsx`) rendered inside the composer's control row; `data-testid="acp-mode-control"` and `data-testid="acp-config-overflow"`.

- [ ] **Step 1: Failing component test:** render `AcpConfigControls` with a model option (`type: 'select'`, `category: 'model'`), a mode option, and a misc option → model renders in the model-selector slot, mode renders as `TabsTriggerCompact`s, misc lands in the overflow popover; selecting a mode calls `onChange('mode', value)` optimistically and shows `Loading` in the pressed trigger until the promise resolves; a rejected promise reverts the value and fires `errorToast`.

- [ ] **Step 2: Run to verify it fails** (component doesn't exist): `pnpm --filter web test src/features/session/acp-config-controls.test.tsx`.

- [ ] **Step 3: Implement `AcpConfigControls`:**

```tsx
'use client';
import { Badge } from '@/components/ui/badge';
import { Hint } from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import type { AcpSessionConfigOption } from '@kortix/sdk';

const isModeOption = (option: AcpSessionConfigOption) =>
  option.category === 'mode' || option.id === 'mode';
const isModelOption = (option: AcpSessionConfigOption) =>
  option.category === 'model' || option.id === 'model';

export function AcpConfigControls({ options, onChange }: {
  options: AcpSessionConfigOption[];
  onChange: (configId: string, value: unknown) => Promise<boolean>;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const apply = async (option: AcpSessionConfigOption, value: string) => {
    setPendingId(option.id);
    try {
      const applied = await onChange(option.id, value);
      if (!applied) errorToast(`Couldn't update ${option.name ?? option.id}`);
    } finally {
      setPendingId(null);
    }
  };
  const mode = options.find(isModeOption);
  const overflow = options.filter((option) => option.type === 'select' && !isModeOption(option) && !isModelOption(option) && option.options?.length);
  return (
    <div className="flex items-center gap-2">
      {mode?.options?.length ? (
        <Tabs value={String(mode.currentValue ?? '')} onValueChange={(value) => void apply(mode, value)}>
          <TabsListCompact data-testid="acp-mode-control">
            {mode.options.map((choice) => {
              const value = String(choice.value ?? choice.id ?? '');
              return (
                <TabsTriggerCompact key={value} value={value} className="gap-1.5">
                  {pendingId === mode.id && String(mode.currentValue) !== value ? <Loading className="size-3 shrink-0" /> : null}
                  {String(choice.name ?? choice.label ?? value)}
                </TabsTriggerCompact>
              );
            })}
          </TabsListCompact>
        </Tabs>
      ) : null}
      {overflow.length ? (
        <Popover>
          <Hint label="Agent options">
            <PopoverTrigger data-testid="acp-config-overflow" className="text-muted-foreground hover:text-foreground inline-flex size-8 items-center justify-center rounded-md transition-colors active:scale-[0.97]">
              <Settings2 className="size-4" />
            </PopoverTrigger>
          </Hint>
          <PopoverContent align="end" className="w-64 space-y-3">
            {/* one labeled Select variant="popover" per overflow option, same apply() flow */}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
```

Model-typed options: pass through to the composer's existing model-selector slot (`SessionChatInput` already renders `HarnessModelSelector`/`ModelSelector`; feed ACP model options as its choices when the session is ACP-backed — keep `data-testid="harness-model-selector"` and the `data-harness` attribute contract intact). Harness badge in the header: `{agentInfo?.name ? <Badge variant="outline" size="sm">{agentInfo.name}</Badge> : null}` next to the title. Optimistic value: render `option.currentValue` from a local `useState` mirror set before `apply` and reverted on failure.

- [ ] **Step 4: Delete `acp-session-chat.tsx:119-133`**, wire the new props, run the component test + `pnpm --filter web exec tsc --noEmit`, then the e2e selector spec against the dev stack: `pnpm --filter e2e test 14-acp-harness-selector`.

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 16: memoized transcript rows + enter motion

**Files:**
- Create: `apps/web/src/features/session/acp-chat-item-row.tsx`
- Modify: `apps/web/src/features/session/acp-session-chat.tsx` (turns map renders `<AcpChatItemRow>`; stable keys; `isStreaming` computed once for the tail id)
- Test: `apps/web/src/features/session/acp-chat-item-row.test.tsx`

**Interfaces:**
- Consumes: `AcpChatItem` (reference-stable per WA Task 6), `pendingPrompts`, respond callbacks.
- Produces: `const AcpChatItemRow = memo(function AcpChatItemRow(props: { item: AcpChatItem; isTail: boolean; busy: boolean; sessionId: string; pending: AcpPendingPrompts; onRespondPermission; onRespondQuestion; onRejectQuestion; animateEnter: boolean }): JSX.Element)`.

- [ ] **Step 1: Failing test (render-count):**

```tsx
test('appending a chunk re-renders only the tail row', () => {
  const renders = new Map<string, number>();
  // instrument via a test-only onRender prop or React Profiler wrapper
  const { rerender } = render(<TranscriptFixture items={itemsA} />);   // 20 items
  rerender(<TranscriptFixture items={itemsB} />);                      // same refs except new tail object
  expect(renders.get('message-3')).toBe(1);   // untouched row rendered once
  expect(renders.get(tailId)).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails** (inline JSX re-renders every row today).

- [ ] **Step 3: Implement.** Move the per-item JSX from `acp-session-chat.tsx:139-178` into `AcpChatItemRow` wrapped in `memo`. Keys: `item.id` for message/tool, `plan-${item.turnOrdinal ?? index}` for plan, `String(item.id)` (rpc id) for permission/question — never bare `index`. `isStreaming={busy && isTail}` only on the tail message row. Enter motion (skip when `animateEnter` is false — history load, and under `useReducedMotion`):

```tsx
<motion.div
  initial={animateEnter ? { opacity: 0, transform: 'translateY(8px)' } : false}
  animate={{ opacity: 1, transform: 'translateY(0px)' }}
  transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
>
```

`animateEnter` = row ordinal > the max ordinal present at mount (track with a ref in the parent).

- [ ] **Step 4: Web suite + typecheck.**

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 17: permission + question cards — pending/answered states

**Files:**
- Create: `apps/web/src/features/session/acp-request-cards.tsx` (extract + redesign `AcpQuestionCard` and the inline permission block from `acp-session-chat.tsx:153-178, 259-295`)
- Modify: `apps/web/src/features/session/acp-chat-item-row.tsx` (render the new cards)
- Test: `apps/web/src/features/session/acp-request-cards.test.tsx`

**Interfaces:**
- Consumes: `AcpPendingPermission`, `AcpPendingQuestionItem`, `coerceElicitationAnswers` (WA Task 13), respond callbacks returning promises.
- Produces: `<AcpPermissionCard request pending onRespond(optionId?) />`, `<AcpQuestionCard questions pending onSubmit(answers) onReject />`. Both render an **answered** compact state when `pending` is false (they stay in the transcript — no unmount — showing outcome).

- [ ] **Step 1: Failing tests:** (a) clicking an option disables all options and shows `Loading` on the pressed one; (b) when `pending` flips false the card renders the compact answered row (`Allowed — {permission}` with a `kortix-green` tile) and no buttons; (c) a rejected respond promise re-enables options and fires `errorToast`; (d) question form state survives a re-render with new array identity but same `request.id` key; (e) boolean-typed elicitation submits `true`, not `'true'`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Pending permission card:

```tsx
export function AcpPermissionCard({ request, pending, onRespond }: {
  request: AcpPendingPermission; pending: boolean;
  onRespond: (optionId?: string) => Promise<void>;
}) {
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'allowed' | 'rejected' | null>(null);
  const respond = async (optionId?: string) => {
    setInFlight(optionId ?? 'reject');
    try {
      await onRespond(optionId);
      setOutcome(optionId ? 'allowed' : 'rejected');
    } catch {
      errorToast('The response didn’t reach the agent. Try again.');
    } finally {
      setInFlight(null);
    }
  };
  const answered = !pending || outcome !== null;
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {answered ? (
        <motion.div key="answered" {...cardSwap} className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2">
          <span className={cn('flex size-9 items-center justify-center rounded-sm', outcome === 'rejected' ? 'bg-kortix-red/15' : 'bg-kortix-green/15')}>
            {outcome === 'rejected' ? <X className="size-5 text-kortix-red" /> : <Check className="size-5 text-kortix-green" />}
          </span>
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            {outcome === 'rejected' ? 'Rejected' : 'Allowed'} — {request.permission}
          </span>
        </motion.div>
      ) : (
        <motion.div key="pending" {...cardSwap} className="bg-popover rounded-md border px-4 py-3">
          <div className="mb-1 flex items-center gap-3">
            <span className="bg-kortix-orange/15 flex size-9 items-center justify-center rounded-sm">
              <ShieldCheck className="text-kortix-orange size-5" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium">Permission requested</div>
              <div className="text-muted-foreground truncate text-xs">{request.permission}</div>
            </div>
          </div>
          {request.patterns.length ? (
            <div className="mb-3 space-y-1">{request.patterns.map((pattern) => (
              <code key={pattern} className="bg-muted block rounded px-2 py-1 text-xs">{pattern}</code>
            ))}</div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {request.options.map((option) => {
              const id = String(option.optionId ?? option.id ?? option.value);
              return (
                <Button key={id} size="sm" disabled={inFlight !== null} className="active:scale-[0.97]" onClick={() => void respond(id)}>
                  {inFlight === id ? <Loading className="size-3.5 shrink-0" /> : null}
                  {option.label}
                </Button>
              );
            })}
            <Button size="sm" variant="outline" disabled={inFlight !== null} onClick={() => void respond()}>
              {inFlight === 'reject' ? <Loading className="size-3.5 shrink-0" /> : null}
              Reject
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const cardSwap = {
  initial: { opacity: 0, scale: 0.98, filter: 'blur(4px)' },
  animate: { opacity: 1, scale: 1, filter: 'blur(0px)' },
  exit: { opacity: 0, scale: 0.98, filter: 'blur(4px)' },
  transition: { type: 'spring', duration: 0.3, bounce: 0 },
} as const;
```

Question card: same shell (`ShieldCheck`→`MessageCircleQuestion`, tile `bg-kortix-yellow/15 text-kortix-yellow`); submit path runs `onSubmit(coerceElicitationAnswers(answers, request.params))`; answered state shows "Answered" / "Dismissed". The parent passes `pending={pendingPermissionIds.has(...)}` exactly as today, but the card no longer returns `null` when not pending — it renders the answered state (the optimistic echo makes this flip instant).

- [ ] **Step 4: Web suite + typecheck; manual pass in the running app** (permission flow via a real harness session; use the `run` project skill / dev stack).

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 18: session states — boot skeleton, empty, terminal error, reconnect pill, protocol disclosure, per-turn plan UI

**Files:**
- Modify: `apps/web/src/features/session/acp-session-chat.tsx` (states + raw-frame grouping), `apps/web/src/features/session/acp-tool-call-card.tsx` (`AcpPlanCard` status ticks)
- Test: `apps/web/src/features/session/acp-session-chat.test.tsx` (rewrite — it must render the component; the current file only re-tests SDK projections)

**Interfaces:**
- Consumes: `connection: AcpConnectionState`, `errorInfo: AcpSessionError | null` (WA Task 14), `ready`, `busy`.
- Produces: rendering contract per state (asserted by the tests): `!ready && !errorInfo` → 4 `Skeleton` rows (`h-16 rounded-md` message-shaped); `ready && items.length === 0` → `EmptyState`; `errorInfo?.terminal` → `ErrorState size="sm"` with a retry `Button` (calls `connect()` via a new hook-returned `retry`— add as additive field in WA Task 14 if absent); `connection === 'reconnecting'` → composer pill `<span className="text-muted-foreground flex items-center gap-2 text-xs"><Loading className="size-3 shrink-0" />Reconnecting…</span>` while the transcript stays rendered; transient (non-terminal) errors never render the red banner.

- [ ] **Step 1: Failing tests:** one per state above, rendering `AcpSessionChat` with a stubbed `acp` prop object (it's just the hook's return shape — construct literal objects).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Raw frames: replace the per-item `<details>` (`acp-session-chat.tsx:173-178`) with a per-turn accumulation — inside `groupAcpTurns`, split `raw` items out; render once per turn after the visible items:

```tsx
{turnRawItems.length ? (
  <Disclosure variant="outline">
    <DisclosureTrigger variant="outline">
      <Button variant="popover" size="sm" className="text-muted-foreground w-full justify-start rounded-none text-xs">
        Protocol events ({turnRawItems.length})
      </Button>
    </DisclosureTrigger>
    <DisclosureContent variant="outline" contentClassName="border-border border-t">
      <pre className="text-muted-foreground max-h-64 overflow-auto px-4 py-3 text-xs">{JSON.stringify(turnRawItems, null, 2)}</pre>
    </DisclosureContent>
  </Disclosure>
) : null}
```

`AcpPlanCard` entries: render `entry.status === 'completed'` with `Check className="size-3.5 text-kortix-green"`, in-progress with `Loading className="size-3"`, else a `muted-foreground` dot; entry text from `entry.content ?? entry.title ?? String(entry)`.

- [ ] **Step 4: Web suite + typecheck; visual pass light + dark.**

- [ ] **Step 5: Checkpoint — do NOT commit.**

### Task 19: performance proof — replay fixture, profiler budget, e2e

**Files:**
- Create: `apps/web/src/features/session/__fixtures__/acp-replay-session.json` (generated: script `apps/web/scripts/generate-acp-replay-fixture.mjs` emits ~2,000 chunk envelopes + 30 tool calls + 3 permissions with deterministic seeds)
- Create: `apps/web/src/features/session/acp-session-perf.test.tsx`
- Create: `tests/e2e/specs/15-acp-permission-flow.spec.ts`
- Test: themselves

**Interfaces:**
- Consumes: `AcpSession` with injected `scheduleFlush` and fake fetch (SDK test helpers), `AcpSessionChat`.
- Produces: CI-enforced budgets.

- [ ] **Step 1: Write the perf test (it should FAIL only if Tasks 16/WA-6 regressed — write it to encode the budget):**

```tsx
test('replaying 2k envelopes stays within the commit budget', () => {
  const commits: number[] = [];
  render(
    <Profiler id="acp" onRender={(_, __, actualDuration) => commits.push(actualDuration)}>
      <AcpSessionChat acp={sessionAsHookShape(session)} sessionId="s1" sessionTitle="t" />
    </Profiler>,
  );
  replayFixtureThrough(session, fixture, { flushEvery: 16 /* envelopes per flush ≈ one frame batch */ });
  expect(commits.length).toBeLessThanOrEqual(Math.ceil(fixture.length / 16) + 20);
  const slow = commits.filter((duration) => duration > 16);
  expect(slow.length).toBe(0);
});
```

- [ ] **Step 2: Run it**; if it fails, profile and fix within Tasks 16/WA-6's structures (do not raise the budget).

- [ ] **Step 3: e2e permission flow** (`15-acp-permission-flow.spec.ts`, follow `14-acp-harness-selector.spec.ts`'s session-bootstrap helpers): drive a session to a permission request, assert the card appears, click Allow, assert the card swaps to the answered state **without reload** within 1s, reload, assert the answered state persists and no pending card returns.

- [ ] **Step 4: Run e2e against the dev stack**: `pnpm --filter e2e test 15-acp-permission-flow`.

- [ ] **Step 5: Phase gate.** Full web + SDK gates, design-system checklist + make-interfaces-feel-better checklist sweep over every file WB touched (report as Before/After tables). **Do NOT commit** — report everything to Jay; he decides commit/PR/staging.

---

## Self-review notes (kept for the executor)

- Spec §W0/§A1-A6/§B1-B5 all map to tasks: W0→1-4, A1/A2→5+14, reducer→6, A4→7, A3→8-9, busy policy→10, echoes/merge→11, A5→12, A6→13, B1→15, B2→16, B3→17, B4→18, B5→19.
- The `useSession` facade (`react/use-session.ts`) layers over `useAcpSession`; its contract is unchanged by Task 14 (additive fields flow through). If its tests read hook internals, fix the tests' setup, not the contract.
- `#4120` rebase is intentionally NOT a task here — it has its own strategy doc in the 2026-07-14 review; Task 13/16-18 keep `ToolPartRenderer` import paths in one place (`acp-tool-call-card.tsx`, `acp-chat-item-row.tsx`) so the post-rebase re-point is two lines.
- If any WA task's surface-snapshot diff shows a removal, STOP and surface to Jay — that's the alias-never-replace law, not a judgment call.
