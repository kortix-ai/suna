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
import { KortixExecutionEnv } from './kortix-env.ts';
import { DurableSessionStorage, RemoteSessionLog } from './session-store.ts';

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
  envCwd: string;
  envToken?: string;
  envHeaders?: Record<string, string>;
  envTransport?: 'fetch' | 'keepalive' | 'ws';
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
    port: Number(process.env.PORT ?? 8080),
    envUrl: process.env.KORTIX_ENV_URL ?? 'http://127.0.0.1:8100',
    envCwd: process.env.KORTIX_ENV_CWD ?? '/workspace',
    envToken: process.env.KORTIX_ENV_TOKEN,
    envHeaders: process.env.KORTIX_ENV_HEADERS ? JSON.parse(process.env.KORTIX_ENV_HEADERS) : undefined,
    envTransport: (process.env.KORTIX_ENV_TRANSPORT as any) ?? 'keepalive',
    systemPrompt:
      process.env.KORTIX_SYSTEM_PROMPT ??
      'You are a Kortix agent. All file and shell work happens in the environment, never locally.',
    modelMode: mode,
    providerId: process.env.KORTIX_PROVIDER ?? 'openrouter',
    modelId: process.env.KORTIX_MODEL,
    apiKey: process.env.KORTIX_API_KEY,
    gatewayUrl: process.env.KORTIX_GATEWAY_URL,
    storeUrl: process.env.KORTIX_STORE_URL,
    storeHeaders: process.env.KORTIX_STORE_HEADERS ? JSON.parse(process.env.KORTIX_STORE_HEADERS) : undefined,
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
  const env = new KortixExecutionEnv({ baseUrl: cfg.envUrl, cwd: cfg.envCwd, token: cfg.envToken, headers: cfg.envHeaders, transport: cfg.envTransport });

  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });

  let model: any;
  let faux: ReturnType<typeof fauxProvider> | undefined;

  if (cfg.modelMode === 'faux') {
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
  let restoredEntries = 0;
  let restoredMessages: any[] = [];
  if (cfg.storeUrl && cfg.sessionId) {
    const log = new RemoteSessionLog(cfg.storeUrl, cfg.sessionId, cfg.storeHeaders ?? {});
    const opened = await DurableSessionStorage.open({ id: cfg.sessionId } as any, log);
    restoredEntries = opened.restoredEntries;
    session = new Session(opened.storage as any);
    const leaf = await session.getLeafId();
    if (leaf) {
      const entries = await session.findEntriesOnBranch({ start: leaf } as any);
      restoredMessages = entries.filter((e: any) => e.type === 'message').map((e: any) => e.message);
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

  return { agent, env, faux, models, timing, session, restoredEntries, restoredMessages };
}

let LISTEN_UPTIME_MS: number | null = null;
/** Process start -> listening. Captured ONCE at listen; reporting
 *  `Date.now() - BOOT_T0` at request time measures process AGE, not boot. */
let LISTEN_MS: number | null = null;

export async function startWorker(cfg = configFromEnv()) {
  const { agent, env, faux, timing, session, restoredEntries } = await buildHarness(cfg);
  const listeners = new Set<(chunk: string) => void>();

  agent.subscribe((event: any) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const l of listeners) l(line);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');

    // ── Platform compatibility surface ─────────────────────────────────────
    // The session lifecycle (start envelope, wake fences, env fan-out) speaks
    // kortixd's /kortix/* contract. The worker answers just enough of it that
    // a pi session reads as ready without a daemon in the box.
    if (url.pathname === '/kortix/health') {
      const compiled = (globalThis as Record<string, unknown>).__KORTIX_COMPILED__ as
        | { manifest?: { agent_config_etag?: string | null; source_sha?: string; ref?: string } }
        | undefined;
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
        // The pi worker has no OpenCode store to pin — the start path must not
        // wait for one.
        opencode_session_id: null,
        opencode_session_required: false,
        agent_config_etag: compiled?.manifest?.agent_config_etag ?? null,
        commit_sha: compiled?.manifest?.source_sha ?? null,
        branch: compiled?.manifest?.ref ?? null,
        boot_timeline: [{ label: 'worker-listening', atMs: LISTEN_MS ?? 0 }],
        runtime: { build: null, at: null, components: {}, agentSwapPending: false, pinned: false },
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
        environment: { url: cfg.envUrl, cwd: cfg.envCwd, rpcCalls: env.calls.length },
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
          await agent.prompt(String(text ?? ''));
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
          await agent.prompt(String(text ?? ''));
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
          await agent.prompt(String(text ?? ''));
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
  return { server, agent, env, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// No self-start guard here: src/main.ts is the bundle's sole entrypoint and
// owns startup. In the compiled artifact every module shares one
// import.meta.url, so a guard here fired ALONGSIDE main's start — two binds on
// one port, EADDRINUSE ~1s after boot, dead worker. Found on the first
// dev-served artifact; the api test now asserts survival past that window.
