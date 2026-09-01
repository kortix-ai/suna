/**
 * kortix-worker (spike) — the harness, and only the harness.
 *
 * What makes this a worker rather than "an agent running on a box":
 *
 *   toolContext: { env: new KortixExecutionEnv(...) }
 *
 * pi-agent-core's built-in bash/read/write/edit tools resolve their filesystem
 * and shell out of that context. Handing them a KortixExecutionEnv instead of
 * NodeExecutionEnv means the agent has no reachable path to this process's own
 * disk through any default tool. That is the harness/environment split, and it
 * is one object, not a rewritten toolset.
 *
 * Two model modes:
 *   faux  — a scripted provider. No credentials, no network. Used by the proof.
 *   real  — a normal provider; KORTIX_GATEWAY_URL sets ModelAuth.baseUrl so
 *           traffic goes through the Kortix LLM gateway rather than direct.
 */
import { createServer } from 'node:http';
import {
  Agent,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-agent-core';
import {
  InMemoryCredentialStore,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Session } from '@earendil-works/pi-agent-core';
import { ChatEventAdapter } from './chat-events.ts';
import { KortixExecutionEnv } from './kortix-env.ts';
import { LazyKortixEnv } from './lazy-env.ts';
import { RuntimeSurface } from './runtime-surface.ts';
import { DurableSessionStorage, RemoteSessionLog } from './session-store.ts';
import { type TurnEndIdentity, buildTurnEndRelay, scheduleBootReconcile } from './turn-end-relay.ts';

/**
 * pi's session layer runs `assertJsonSerializable` on every durable payload:
 * no `undefined`, no non-finite numbers, no cycles. That is a deliberate and
 * correct guard — it means anything accepted into a session is guaranteed
 * persistable — but provider messages routinely carry `undefined` optional
 * fields, so a bridge has to normalize before appending.
 *
 * Dropping an `undefined`-valued key is lossless: JSON has no representation
 * for it, and a reader cannot distinguish "absent" from "present but
 * undefined". Non-finite numbers would be a real loss, so those are surfaced
 * rather than silently coerced.
 */
function toDurable<T>(value: T, path = 'message'): T {
  if (value === null) return value;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`non-finite number at ${path} cannot be persisted`);
  }
  if (Array.isArray(value)) return value.map((v, i) => toDurable(v, `${path}[${i}]`)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toDurable(v, `${path}.${k}`);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * The branch's messages, oldest first.
 *
 * `findEntriesOnBranch` walks parent links UP from the leaf, so it hands the
 * branch back NEWEST-FIRST. Both consumers need the opposite: the agent
 * replays this array as its conversation history, and the runtime surface
 * mints wire ids in array order. Unsorted, a resumed session came back with
 * its questions answered backwards. Sort on the entry's own `seq` — the walk
 * order is pi's business, the ordering contract is ours.
 */
export function restoredMessagesFromEntries(entries: readonly any[]): any[] {
  return entries
    .filter((e: any) => e.type === 'message')
    .sort((a: any, b: any) => a.seq - b.seq)
    .map((e: any) => e.message);
}

/**
 * True time-to-first-token, measured at the provider stream boundary.
 *
 * NOTE — this file previously claimed that `Agent.subscribe` emits no text
 * deltas and that a streaming frontend must tap the pi-ai layer. That was
 * WRONG. `AgentEvent` includes `message_update`, which carries both the
 * accumulating message and the raw `assistantMessageEvent`; a 30-word answer
 * produces 21 of them (text_start / 19x text_delta / text_end). S0.5's adapter
 * streams straight off Agent events and needs no pi-ai tap.
 *
 * This wrapper is kept only because it times the FIRST byte at the provider
 * boundary, before the Agent loop sees it — a slightly earlier and more
 * honest instant for a latency number. It is instrumentation, not plumbing.
 */
function tapFirstToken(inner: AssistantMessageEventStream, onFirst: (ms: number) => void): AssistantMessageEventStream {
  const out = new AssistantMessageEventStream();
  const t0 = process.hrtime.bigint();
  let fired = false;
  (async () => {
    try {
      for await (const ev of inner) {
        if (!fired) {
          const t = (ev as any)?.type;
          if (t === 'text_delta' || t === 'text_start' || t === 'thinking_delta') {
            fired = true;
            onFirst(Number(process.hrtime.bigint() - t0) / 1e6);
          }
        }
        out.push(ev);
      }
      out.end(await inner.result());
    } catch {
      out.end(undefined as any);
    }
  })();
  return out;
}

const BOOT_T0 = Date.now();

/**
 * Seconds since the machine booted, read at the moment we start serving.
 *
 * This is the number the whole project turns on. The in-guest clock the
 * platform already has (`bootMark()` in kortixd) starts at PROCESS start, so
 * it cannot see VM allocation or rootfs restore — the two costs the small
 * image actually removes. Reading /proc/uptime at listen time gives
 * machine-boot -> serving from inside the box, with no dependency on the
 * benchmark host's clock or its latency to the provider.
 */
function vmUptimeMs(): number | null {
  try {
    const raw = require('node:fs').readFileSync('/proc/uptime', 'utf8');
    return Math.round(Number.parseFloat(raw.split(' ')[0]) * 1000);
  } catch { return null; }
}

export interface WorkerConfig {
  port: number;
  envUrl: string;
  /** True only when KORTIX_ENV_URL was set explicitly (spike/bench rigs). */
  envUrlExplicit?: boolean;
  envCwd: string;
  envToken?: string;
  envHeaders?: Record<string, string>;
  envTransport?: 'fetch' | 'keepalive' | 'ws';
  /** Lazy-environment identity (P1.7): all four present → first compute tool
   *  call provisions the session's environment through the Kortix API. */
  apiUrl?: string;
  kortixToken?: string;
  projectId?: string;
  systemPrompt: string;
  modelMode: 'faux' | 'real';
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  gatewayUrl?: string;
  /** Durable session store. Absent = in-memory only (conversation dies with the process). */
  storeUrl?: string;
  storeHeaders?: Record<string, string>;
  sessionId?: string;
}

export function configFromEnv(): WorkerConfig {
  const mode = (process.env.KORTIX_MODEL_MODE ?? 'faux') as 'faux' | 'real';
  return {
    // KORTIX_SERVICE_PORT is what the PLATFORM injects and what the session
    // proxy dials (sandbox_url ends /8000); PORT is the bench's name. Reading
    // only PORT made every real session bind 8080 while the proxy asked 8000,
    // so the box was healthy and answered 502 "proxy upstream error" forever —
    // with the worker's own log saying "worker listening" the whole time.
    port: Number(process.env.KORTIX_SERVICE_PORT ?? process.env.PORT ?? 8080),
    envUrl: process.env.KORTIX_ENV_URL ?? 'http://127.0.0.1:8100',
    envUrlExplicit: Boolean(process.env.KORTIX_ENV_URL),
    envCwd: process.env.KORTIX_ENV_CWD ?? '/workspace',
    apiUrl: process.env.KORTIX_API_URL,
    kortixToken: process.env.KORTIX_TOKEN,
    projectId: process.env.KORTIX_PROJECT_ID,
    envToken: process.env.KORTIX_ENV_TOKEN,
    envHeaders: process.env.KORTIX_ENV_HEADERS ? JSON.parse(process.env.KORTIX_ENV_HEADERS) : undefined,
    envTransport: (process.env.KORTIX_ENV_TRANSPORT as any) ?? 'keepalive',
    systemPrompt:
      process.env.KORTIX_SYSTEM_PROMPT ??
      'You are a Kortix agent. All file and shell work happens in the environment, never locally.',
    modelMode: mode,
    providerId: process.env.KORTIX_PROVIDER ?? 'openrouter',
    modelId: process.env.KORTIX_MODEL,
    // The platform injects the session credential and the gateway base under
    // its OWN names (KORTIX_TOKEN / KORTIX_LLM_BASE_URL, see
    // provisionSessionSandbox). The bench sets the KORTIX_API_KEY /
    // KORTIX_GATEWAY_URL pair. Read both, or a real session finds no
    // credential at all and cannot start — the bench names are the only ones
    // that ever existed here, so nothing outside a bench ever worked.
    apiKey: process.env.KORTIX_API_KEY ?? process.env.KORTIX_TOKEN,
    gatewayUrl: process.env.KORTIX_GATEWAY_URL ?? process.env.KORTIX_LLM_BASE_URL,
    storeUrl: process.env.KORTIX_STORE_URL,
    // The control plane sets only KORTIX_STORE_URL and relies on the session
    // credential it already injects; the bench passes explicit headers. Without
    // this fallback a real session would post to the log unauthenticated and
    // every append would 401 — losing the whole transcript, silently, because
    // appends are the only thing that crosses the network.
    storeHeaders: process.env.KORTIX_STORE_HEADERS
      ? JSON.parse(process.env.KORTIX_STORE_HEADERS)
      : process.env.KORTIX_TOKEN
        ? { authorization: `Bearer ${process.env.KORTIX_TOKEN}` }
        : undefined,
    sessionId: process.env.KORTIX_SESSION_ID ?? 'session-local',
  };
}

/**
 * Bind an AgentHarnessTool (5-arg execute, takes a context) down to a plain
 * AgentTool (4-arg execute) by closing over the context.
 *
 * pi-agent-core ships two tool shapes. `createBashTool()` and friends are
 * AgentHarnessTools: they take `{ env }` as a 5th argument so the harness can
 * resolve a fresh context per turn. `Agent` takes plain AgentTools. Binding
 * here is what pins EVERY built-in tool to the Kortix environment for the
 * lifetime of the process — there is no per-call opportunity to substitute a
 * local filesystem.
 */
function bindTool(tool: any, context: object) {
  return {
    ...tool,
    execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) =>
      tool.execute(toolCallId, params, signal, onUpdate, context),
  };
}

export async function buildHarness(cfg: WorkerConfig) {
  // P1.7 lazy environment: in a session sandbox (identity present, no explicit
  // env URL) the first compute tool call provisions the session's environment
  // through the Kortix API and every operation then runs over the provider
  // edge. Bench/spike rigs keep the direct-URL path by setting KORTIX_ENV_URL.
  const lazy =
    !cfg.envUrlExplicit && cfg.apiUrl && cfg.kortixToken && cfg.projectId && cfg.sessionId
      ? new LazyKortixEnv({
          apiUrl: cfg.apiUrl,
          token: cfg.kortixToken,
          projectId: cfg.projectId,
          sessionId: cfg.sessionId,
          cwd: cfg.envCwd,
        })
      : null;
  const env =
    lazy ??
    new KortixExecutionEnv({ baseUrl: cfg.envUrl, cwd: cfg.envCwd, token: cfg.envToken, headers: cfg.envHeaders, transport: cfg.envTransport });

  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });

  let model: any;
  let faux: ReturnType<typeof fauxProvider> | undefined;

  // A real session with no credential used to take the `else` branch and throw
  // during boot, which stopped the sandbox — the operator saw a session that
  // went `running` then died, with the cause nowhere in the session record.
  // Degrade to faux and SAY SO instead: the turn still answers (emptily), and
  // the reason is in /kortix/health where it can be read.
  const missingCredential = cfg.modelMode === 'real' && !cfg.apiKey;
  if (missingCredential) {
    console.error(
      '[worker] KORTIX_MODEL_MODE=real but no credential (KORTIX_API_KEY / KORTIX_TOKEN); using faux',
    );
  }
  if (cfg.modelMode === 'faux' || missingCredential) {
    faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', name: 'Faux' }] });
    models.setProvider(faux.provider);
    model = faux.getModel();
  } else {
    // Provider is selectable so the benchmark can use the same path production
    // does (OpenRouter behind the Kortix gateway), not a second one.
    const provider =
      cfg.providerId === 'openrouter'
        ? (await import('@earendil-works/pi-ai/providers/openrouter')).openrouterProvider()
        : (await import('@earendil-works/pi-ai/providers/anthropic')).anthropicProvider();
    models.setProvider(provider);
    if (cfg.apiKey) {
      await credentials.modify(provider.id, async () => ({
        type: 'api_key',
        key: cfg.apiKey,
        // KORTIX_GATEWAY_URL is the entire gateway integration: ModelAuth.baseUrl.
        ...(cfg.gatewayUrl ? { env: { baseUrl: cfg.gatewayUrl } } : {}),
      }));
    }
    const list = models.getModels(provider.id);
    model = cfg.modelId ? models.getModel(provider.id, cfg.modelId) : list[0];
    if (!model && cfg.modelId && cfg.gatewayUrl && list[0]) {
      // Behind the Kortix gateway the model ref is the GATEWAY's contract
      // (native `<provider>/<model>`), not a catalog-membership question —
      // the first dev session died here with "no model resolved" because the
      // baked ref is not an OpenRouter catalog id. Clone a catalog entry for
      // its field shape, stamp the requested ref, and point it at the
      // gateway directly so routing does not depend on auth-layer env
      // plumbing.
      model = { ...list[0], id: cfg.modelId, name: cfg.modelId, baseUrl: cfg.gatewayUrl };
    }
    if (!model) throw new Error(`no model resolved for provider ${provider.id}`);
  }

  // THE SEAM. One context object, bound into every built-in tool.
  const toolContext = { env };
  const tools = [createBashTool(), createReadTool(), createWriteTool(), createEditTool()]
    .map((t) => bindTool(t, toolContext));

  // Durable transcript. The worker is a cache of it, not its owner: kill this
  // process and the conversation is still whole in the store.
  let session: Session | undefined;
  /** Non-null when the transcript is NOT being persisted; surfaced in health. */
  let storeError: string | null = null;
  let restoredEntries = 0;
  let restoredMessages: any[] = [];
  if (cfg.storeUrl && cfg.sessionId) {
    const log = new RemoteSessionLog(cfg.storeUrl, cfg.sessionId, cfg.storeHeaders ?? {});
    try {
      const opened = await DurableSessionStorage.open({ id: cfg.sessionId } as any, log);
      restoredEntries = opened.restoredEntries;
      session = new Session(opened.storage as any);
      const leaf = await session.getLeafId();
      if (leaf) {
        const entries = await session.findEntriesOnBranch({ start: leaf } as any);
        restoredMessages = restoredMessagesFromEntries(entries);
      }
    } catch (error) {
      // Durability is a FEATURE, not a precondition for answering. Unguarded,
      // any store fault — a 401, an outage, a shape change — threw here before
      // the worker ever listened, so the box died at boot with the cause
      // nowhere: the operator saw a session go `running` and then 502 forever.
      // Degrade to in-memory, say so in health, and keep serving.
      storeError = error instanceof Error ? error.message : String(error);
      console.error(`[worker] durable session store unavailable, continuing in memory: ${storeError}`);
      session = undefined;
      restoredEntries = 0;
      restoredMessages = [];
    }
  }

  const timing: { firstTokenMs: number | null } = { firstTokenMs: null };

  const agent = new Agent({
    streamFn: (m: any, ctx: any, opts: any) =>
      tapFirstToken(models.streamSimple(m, ctx, opts), (ms) => {
        if (timing.firstTokenMs === null) timing.firstTokenMs = ms;
      }),
    toolExecution: 'sequential',
    initialState: {
      systemPrompt: cfg.systemPrompt,
      model,
      thinkingLevel: 'off',
      tools,
      // Seeded from the durable store, so a restarted worker continues the
      // same conversation rather than starting a new one.
      messages: restoredMessages,
    } as any,
  });

  // Bridge Agent -> Session. AgentHarness would own this natively, but every
  // one of its 23 methods throws HarnessNotImplemented in 0.84.3, so the
  // projection is ours — the fallback the plan named for exactly this case.
  // The on-disk shape is still pi's own MessageEntry, so this stays compatible
  // when AgentHarness lands.
  if (session) {
    let persisted = restoredMessages.length;
    agent.subscribe(async (event: any) => {
      if (event.type !== 'agent_end' && event.type !== 'turn_end') return;
      const all = agent.state.messages;
      for (let i = persisted; i < all.length; i++) {
        await session!.appendMessage(toDurable(all[i])).catch((e) =>
          console.error(JSON.stringify({ msg: 'session append failed', error: String(e?.message ?? e) })),
        );
      }
      persisted = all.length;
    });
  }

  // Close the control plane's turn row.
  //
  // The sandbox daemon does this for an OpenCode session by watching OpenCode's
  // NATIVE `/event` stream, which the pi worker does not serve — so without
  // this, a pi turn's row stays `active` forever. Measured on pi.kortix.com
  // 2026-08-29: nine rows across four sessions, nine still `active`, the oldest
  // 67 minutes after its answer was written. See `./turn-end-relay`.
  //
  // A SEPARATE subscriber from the persistence one above, deliberately: the
  // relay must fire even if a message append throws, and an append must not be
  // skipped because a relay is retrying. Ordering between them does not matter
  // — the control plane's row and the durable transcript are independent
  // records.
  const relayTurnEnd = buildTurnEndRelay(cfg);
  // WHICH turn ended. `completeSandboxTurn` selects the row by identity, so a
  // relay that names no turn closes none and still answers 200 — set by
  // `startWorker` once the RuntimeSurface exists (it is built after the
  // harness, and it is the only holder of the `ses_pi…` id).
  let turnIdentity: (() => TurnEndIdentity | null) | null = null;
  const setTurnIdentity = (source: () => TurnEndIdentity | null) => {
    turnIdentity = source;
  };
  // Close whatever a PREVIOUS process left open. Armed here, run after listen.
  const bootReconcile = scheduleBootReconcile({
    relay: relayTurnEnd,
    identity: () => turnIdentity?.() ?? null,
  });
  agent.subscribe((event: any) => {
    // ANY agent event means this process is doing work, so the boot reconcile
    // must never fire — it exists only for a session that booted idle.
    bootReconcile.noteTurnStarted();
    // `agent_end` ONLY — never pi's `turn_end`.
    //
    // The two systems use the word "turn" for different things. In pi, a TURN
    // is ONE provider round: `turn_end` carries a single assistant message plus
    // its `toolResults`, and the loop then decides whether to start another
    // round (`shouldStopAfterTurn` — @earendil-works/pi-agent-core types.d.ts).
    // `agent_end` is the last event of the RUN. A Kortix `session_turns` row
    // spans the whole run — prompt to final answer.
    //
    // Relaying on `turn_end` therefore closed the row on the FIRST tool round,
    // while the agent was still working: the Stop button and the working
    // indicator disappeared mid-answer, and the box's deadline was pulled in to
    // the idle tail under a run that was still generating. It looked correct in
    // testing because a prompt that uses NO tools has exactly one pi turn, so
    // `turn_end` and `agent_end` arrive back to back and the second relay is a
    // harmless no-op.
    if (event.type !== 'agent_end') return;
    // Snapshotted HERE, synchronously: `runTurn`'s `finally` clears the active
    // message id as soon as `agent.prompt()` resolves, so reading it inside the
    // awaited relay would read null and match nothing.
    const identity = turnIdentity?.() ?? null;
    // `error` when the agent ended on a failure, so the API records the same
    // end_reason the daemon would have. `void`: the relay owns its retries and
    // never throws, and the turn must not wait on bookkeeping.
    void relayTurnEnd(event.error || event.status === 'error' ? 'error' : 'idle', identity);
  });

  return { agent, env, faux, models, timing, session, restoredEntries, restoredMessages, storeError, bootReconcile, setTurnIdentity };
}

let LISTEN_UPTIME_MS: number | null = null;
/** Process start -> listening. Captured ONCE at listen; reporting
 *  `Date.now() - BOOT_T0` at request time measures process AGE, not boot. */
let LISTEN_MS: number | null = null;

export async function startWorker(cfg = configFromEnv()) {
  const { agent, env, faux, timing, session, restoredEntries, restoredMessages, storeError, bootReconcile, setTurnIdentity } =
    await buildHarness(cfg);
  const listeners = new Set<(chunk: string) => void>();

  agent.subscribe((event: any) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const l of listeners) l(line);
  });

  // ── Kortix Runtime API (/kortix/opencode/*) ─────────────────────────────
  // The product's session surface: /state, paged /messages, ONE sequenced
  // /events SSE the API relays. One PERSISTENT adapter feeds one surface — the
  // stream and the transcript can never disagree, and message ids stay unique
  // and lexicographically ordered across the whole session.
  const compiledPayload = (globalThis as Record<string, unknown>).__KORTIX_COMPILED__ as
    | {
        manifest?: { agent_config_etag?: string | null; default_agent?: string | null };
        agentConfig?: {
          model?: string;
          agent?: Record<string, { description?: string; model?: string }>;
        } | null;
      }
    | undefined;
  const surface = new RuntimeSurface({
    sessionId: cfg.sessionId ?? 'session-local',
    token: cfg.kortixToken,
    agentName:
      process.env.KORTIX_AGENT ??
      compiledPayload?.manifest?.default_agent ??
      undefined,
    agentConfigEtag: compiledPayload?.manifest?.agent_config_etag ?? null,
    agents: compiledPayload?.agentConfig?.agent ?? {},
    defaultModel: cfg.modelId ?? compiledPayload?.agentConfig?.model ?? null,
    workspace: cfg.envCwd,
    // The Stop button. `session.abort` on the runtime client is POST
    // `session/:id/abort`, which this surface answered with its catch-all 404
    // until now — so the UI showed "Interrupted" from its own optimistic
    // receipt while the agent kept generating (reported 2026-08-29, pi).
    //
    // Guarded: `abort()` on an idle agent is a no-op, and a throw here must not
    // take down the request — the caller has already decided to stop.
    onAbort: () => {
      try {
        (agent as { abort?: () => void }).abort?.();
      } catch (e) {
        console.error(
          JSON.stringify({ msg: 'agent abort failed', error: String((e as Error)?.message ?? e) }),
        );
      }
    },
  });

  // The relay's turn identity. Set here because the surface is the only holder
  // of the `ses_pi…` session id and the live user message id, and it does not
  // exist until after the harness that owns the relay subscription.
  setTurnIdentity(() => surface.turnEndIdentity());
  // A resumed box must come back with the SAME conversation: one pi instance is
  // one session. Seed BEFORE the adapter is wired so every id this turn mints
  // sorts above the restored transcript instead of back inside it.
  const seededMessages = surface.seedRestoredMessages(restoredMessages);
  if (seededMessages > 0) {
    console.log(
      JSON.stringify({ msg: 'transcript restored', messages: seededMessages, entries: restoredEntries }),
    );
  }
  const wireAdapter = new ChatEventAdapter({
    sessionID: surface.rootId,
    mintMessageId: surface.mintMessageId,
  });
  agent.subscribe((event: any) => {
    try {
      for (const wire of wireAdapter.translate(event)) surface.publishWire(wire);
    } catch (e: any) {
      console.error(JSON.stringify({ msg: 'wire adapter failed', error: String(e?.message ?? e) }));
    }
  });
  // pi's stream carries the assistant; the USER message is published at prompt
  // time so the transcript shows the turn the moment it starts. `explicitId`
  // is the wire id the API pre-placed for a composer/queue send (prompt_async's
  // `messageID`): the worker MUST reuse it so the transcript, the API's inbox
  // placement, and the turn oracle all key on the same id.
  const publishUserMessage = (text: string, explicitId?: string): string => {
    surface.noteUserText(text);
    const id = explicitId ?? surface.mintMessageId();
    surface.publishWire({
      type: 'message.updated',
      properties: {
        sessionID: surface.rootId,
        info: {
          id,
          role: 'user',
          sessionID: surface.rootId,
          time: { created: Date.now() },
        },
      },
    });
    surface.publishWire({
      type: 'message.part.updated',
      properties: {
        sessionID: surface.rootId,
        part: {
          id: `${id}-p0`,
          messageID: id,
          sessionID: surface.rootId,
          type: 'text',
          text,
        },
      },
    });
    return id;
  };
  // Serialize turns: pi's Agent runs one conversation, and a second concurrent
  // `prompt()` would interleave two turns' events on one stream. A composer
  // send that lands while a turn is live queues behind it (OpenCode's own
  // prompt_async serializes the same way).
  let turnChain: Promise<unknown> = Promise.resolve();
  const runTurn = async (text: string, opts?: { userMessageId?: string }) => {
    const prev = turnChain;
    turnChain = (async () => {
      await prev.catch(() => {});
      publishUserMessage(text, opts?.userMessageId);
      surface.markTurn(opts?.userMessageId ?? null, true);
      try {
        await agent.prompt(text);
      } finally {
        surface.markTurn(opts?.userMessageId ?? null, false);
      }
    })();
    return turnChain;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');

    if (url.pathname.startsWith('/kortix/opencode/')) {
      if (surface.handle(req, res, url)) return;
    }
    if (url.pathname === '/session' || url.pathname.startsWith('/session/')) {
      if (surface.handleRawSessionList(req, res, url)) return;
    }

    // ── prompt_async — the composer/queue delivery route ────────────────────
    // The API's session lifecycle delivers EVERY composer send and queued
    // prompt with POST /session/:rootId/prompt_async (engine.ts postPrompt),
    // NOT the worker's own /say|/turn. OpenCode answers 204 and runs the turn
    // in the background, streaming events; the worker matches that contract, so
    // a send reaches the pi agent and the response streams back through the
    // /events SSE. Without this route the prompt 404s, the delivery loop retries
    // to `pending`, and the composer's Stop button spins forever with no reply.
    {
      const m = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (m && req.method === 'POST') {
        const sid = decodeURIComponent(m[1]!);
        if (sid !== surface.rootId) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(
            JSON.stringify({ error: 'unknown session' }),
          );
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let text = '';
          let messageID: string | undefined;
          try {
            const parsed = JSON.parse(body || '{}') as {
              messageID?: string;
              parts?: Array<{ type?: string; text?: string }>;
            };
            messageID = typeof parsed.messageID === 'string' ? parsed.messageID : undefined;
            text = (parsed.parts ?? [])
              .filter((p) => p?.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text)
              .join('');
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' }).end(
              JSON.stringify({ error: 'invalid json body' }),
            );
            return;
          }
          // Accept immediately (204), exactly like OpenCode's prompt_async — the
          // turn runs in the background and its events reach the client over the
          // /events SSE. runTurn serializes, so a send during a live turn queues.
          res.writeHead(204).end();
          void runTurn(text, { userMessageId: messageID }).catch((e: any) =>
            console.error(
              JSON.stringify({ msg: 'prompt_async turn failed', error: String(e?.message ?? e) }),
            ),
          );
        });
        return;
      }
    }

    // ── Platform compatibility surface ─────────────────────────────────────
    // The session lifecycle (start envelope, wake fences, env fan-out) speaks
    // kortixd's /kortix/* contract. The worker answers just enough of it that
    // a pi session reads as ready without a daemon in the box.
    if (url.pathname === '/kortix/health') {
      const compiled = (globalThis as Record<string, unknown>).__KORTIX_COMPILED__ as
        | { manifest?: { agent_config_etag?: string | null; source_sha?: string; ref?: string } }
        | undefined;
      // Turn probe: the API's turn-lifecycle polls ?turn=1 to renew the box's
      // deadline while a turn runs and to settle it when done. Answer from the
      // surface's live turn state so the reaper never stops the box mid-turn.
      const turnProbe =
        url.searchParams.get('turn') === '1'
          ? surface.turnProbe(url.searchParams.get('turn_message_id')?.trim() || null)
          : null;
      const body = JSON.stringify({
        daemon: 'ok',
        status: 'ok',
        runtimeReady: true,
        workload: 'session',
        opencode: 'ok',
        engine: 'pi',
        uptime_s: Math.floor((Date.now() - BOOT_T0) / 1000),
        repo_required: false,
        repo_ready: true,
        boot_error: null,
        // null = the transcript is durable. A string means this session is
        // answering but its history will NOT survive the process.
        store_error: storeError,
        // The pi worker has no OpenCode store to pin — the start path must not
        // wait for one.
        opencode_session_id: surface.rootId,
        opencode_session_required: false,
        agent_config_etag: compiled?.manifest?.agent_config_etag ?? null,
        commit_sha: compiled?.manifest?.source_sha ?? null,
        branch: compiled?.manifest?.ref ?? null,
        boot_timeline: [{ label: 'worker-listening', atMs: LISTEN_MS ?? 0 }],
        runtime: { build: null, at: null, components: {}, agentSwapPending: false, pinned: false },
        ...(turnProbe ?? {}),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }

    // Env fan-out and config refresh land here on secret writes and reloads.
    // Acknowledged, not applied: a pi worker's config is immutable per artifact
    // — a new commit compiles a new artifact. Refusing (non-200) would surface
    // every flagged session as a sync failure in the fan-out's logs.
    if ((url.pathname === '/kortix/env' || url.pathname === '/kortix/refresh') && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
         .end(JSON.stringify({ ok: true, changed: false, engine: 'pi' }));
      return;
    }

    if (url.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        bootMs: LISTEN_MS,
        processAgeMs: Date.now() - BOOT_T0,
        vmUptimeAtListenMs: LISTEN_UPTIME_MS,
        vmUptimeNowMs: vmUptimeMs(),
        modelMode: cfg.modelMode,
        environment:
          env instanceof LazyKortixEnv
            ? {
                mode: 'lazy',
                attached: env.attached,
                external_id: env.externalId,
                cwd: cfg.envCwd,
                rpcCalls: env.calls.length,
              }
            : { mode: 'url', url: cfg.envUrl, cwd: cfg.envCwd, rpcCalls: env.calls.length },
        store: cfg.storeUrl ? { url: cfg.storeUrl, sessionId: cfg.sessionId, restoredEntries } : null,
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (c: string) => res.write(c);
      listeners.add(send);
      req.on('close', () => listeners.delete(send));
      return;
    }

    if (url.pathname === '/prompt' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { text, script } = JSON.parse(body || '{}');
          // The faux provider is scripted per prompt so a test can drive an
          // exact tool call without a model in the loop. Compact wire form:
          //   [{ "tool": "write", "args": {...} }, { "text": "done" }]
          if (faux && Array.isArray(script)) {
            faux.setResponses(
              script.map((step: any) =>
                step.tool
                  ? fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], { stopReason: 'toolUse' })
                  : fauxAssistantMessage(String(step.text ?? ''), { stopReason: 'stop' }),
              ),
            );
          }
          await runTurn(String(text ?? ''));
          const result = { messages: agent.state.messages.length };
          const payload = JSON.stringify({ ok: true, result, rpcCalls: env.calls.map((c) => c.op) });
          res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
        } catch (e: any) {
          res.writeHead(500, { 'content-type': 'application/json' })
             .end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      });
      return;
    }

    // Streaming turn. The benchmark measures time-to-first-token off the first
    // chunk that carries assistant text, which is what a user actually waits
    // for — not when the turn finishes.
    if (url.pathname === '/turn' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const { text, script } = JSON.parse(body || '{}');
        if (faux && Array.isArray(script)) {
          faux.setResponses(
            script.map((step: any) =>
              step.tool
                ? fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], { stopReason: 'toolUse' })
                : fauxAssistantMessage(String(step.text ?? ''), { stopReason: 'stop' }),
            ),
          );
        }
        const unsub = agent.subscribe((event: any) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        try {
          await runTurn(String(text ?? ''));
          res.write(`event: done\ndata: ${JSON.stringify({ rpcCalls: env.calls.map((c) => c.op) })}\n\n`);
        } catch (e: any) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: String(e?.message ?? e) })}\n\n`);
        } finally {
          unsub();
          res.end();
        }
      });
      return;
    }

    // One real turn, answer + timings, as JSON. This is the endpoint the
    // comparison benchmark calls, and the one to curl by hand.
    if (url.pathname === '/say' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { text } = JSON.parse(body || '{}');
          timing.firstTokenMs = null;
          const t0 = process.hrtime.bigint();
          await runTurn(String(text ?? ''));
          const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
          const last = agent.state.messages.filter((m: any) => m.role === 'assistant').pop();
          const answer = (last?.content ?? [])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              ok: true,
              answer,
              firstTokenMs: timing.firstTokenMs,
              totalMs,
              model: (last as any)?.model ?? null,
              rpcCalls: env.calls.map((c) => c.op),
            }),
          );
        } catch (e: any) {
          res.writeHead(500, { 'content-type': 'application/json' })
             .end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      });
      return;
    }

    // History straight from the durable tree. Present here for convenience;
    // the real point is that the SAME data is readable from the store with no
    // worker running at all — see bench/read-transcript.ts.
    if (url.pathname === '/history') {
      if (!session) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"messages":[]}'); return; }
      const leaf = await session.getLeafId();
      const entries = leaf ? await session.findEntriesOnBranch({ start: leaf } as any) : [];
      const payload = JSON.stringify({
        restoredEntries,
        messages: entries.filter((e: any) => e.type === 'message').map((e: any) => e.message),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
      return;
    }

    if (url.pathname === '/interrupt' && req.method === 'POST') {
      agent.abort();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(cfg.port, '0.0.0.0', r));
  LISTEN_UPTIME_MS = vmUptimeMs();
  LISTEN_MS = Date.now() - BOOT_T0;
  const port = (server.address() as any).port;
  console.log(JSON.stringify({ msg: 'worker listening', port, bootMs: LISTEN_MS, vmUptimeAtListenMs: LISTEN_UPTIME_MS, modelMode: cfg.modelMode, env: cfg.envUrl }));
  // Fire-and-forget, AFTER listen: a session that booted with no work to do
  // tells the control plane so, closing a row a previous process left open.
  // Not awaited — the worker must be answering requests immediately, and the
  // reconcile deliberately waits out its own race window first.
  void bootReconcile.run();
  return { server, agent, env, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// No self-start guard here: src/main.ts is the bundle's sole entrypoint and
// owns startup. In the compiled artifact every module shares one
// import.meta.url, so a guard here fired ALONGSIDE main's start — two binds on
// one port, EADDRINUSE ~1s after boot, dead worker. Found on the first
// dev-served artifact; the api test now asserts survival past that window.
