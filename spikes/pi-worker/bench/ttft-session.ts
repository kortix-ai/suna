/**
 * End-to-end session TTFT benchmark through the same protocol used by Kortix.
 *
 * Both Pi and OpenCode use exactly these runtime routes:
 *
 *   GET  /global/event
 *   GET  /session
 *   POST /session/:id/message
 *
 * Local-only `/turn`, `/prompt`, `/say`, and `/event` routes are deliberately
 * absent. Deployed Pi workers disable the first three, and `/event` is not the
 * product subscription used by the SDK.
 *
 * The clock starts before session creation or the explicit resume request. It includes
 * control-plane work, provider scheduling, image restore, runtime boot, and
 * model time to the first assistant text event.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import {
  type BenchmarkDeclaration,
  JsonSseDecoder,
  type TurnEventObservation,
  TurnEventProbe,
  mintBenchmarkMessageId,
  parseBenchmarkDeclaration,
  selectRuntimeSessionId,
} from './ttft-session-protocol.ts';

const TOOL_SENTINEL = 'KORTIX-TOOL-PROBE';
const DEFAULT_PROMPT = 'Reply with exactly the word READY and nothing else.';
const DEFAULT_TOOL_PROMPT = `Use the bash tool to run exactly this command: echo ${TOOL_SENTINEL} . Then reply with only its output.`;
const READY_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 300_000;

interface CliConfig {
  base: string;
  project: string;
  jwt: string;
  session?: string;
  agent: string;
  baseRef: string;
  runs: number;
  keep: boolean;
  dryRun: boolean;
  output: string;
  prompt: string;
  expectedText: string | null;
  declaration: BenchmarkDeclaration;
}

interface ApiSessionRow {
  session_id?: string;
  agent_name?: string | null;
  base_ref?: string | null;
  sandbox_url?: string | null;
  sandbox_provider?: string | null;
  opencode_session_id?: string | null;
  status?: string;
  metadata?: Record<string, unknown>;
  session_start_timeline?: { totalMs?: unknown };
}

interface RuntimeHealth {
  runtimeReady?: boolean;
  engine?: string;
  opencode?: string;
  commit_sha?: string | null;
  branch?: string | null;
  agent_config_etag?: string | null;
  model_mode?: string;
  opencode_session_id?: string | null;
}

interface RunResult {
  run: number;
  ok: boolean;
  startedAt: string;
  sessionId?: string;
  runtimeSessionId?: string;
  createMs?: number;
  startMs?: number;
  statusBeforeStart?: string;
  readyMs?: number;
  sessionReadMs?: number;
  sessionDiscoveryMs?: number;
  eventRequestMs?: number;
  eventResponseMs?: number;
  messageRequestMs?: number;
  firstTokenMs?: number;
  firstToolResultMs?: number;
  messageResponseMs?: number;
  totalMs?: number;
  serverTimelineMs?: number | null;
  provider?: string | null;
  runtimeHealth?: RuntimeHealth;
  observedModels?: string[];
  assistantMessageIds?: string[];
  eventCount?: number;
  responseText?: string;
  warmMarkerAtRead?: boolean | null;
  cleanup?: { kept: boolean; status?: number; durationMs?: number; alreadyStopped?: boolean; error?: string };
  error?: string;
}

function option(argv: readonly string[], name: string): string | undefined {
  const split = argv.find((value) => value.startsWith(`--${name}=`));
  if (split) return split.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function required(argv: readonly string[], name: string): string {
  const value = option(argv, name)?.trim();
  if (!value || value.startsWith('--')) throw new Error(`missing --${name}`);
  return value;
}

function usage(): string {
  return `Usage:
  bun bench/ttft-session.ts \\
    --base https://pi.kortix.com/v1 \\
    --project <uuid> \\
    --agent <name> \\
    --base-ref <commit-or-ref> \\
    --runtime pi \\
    --provider daytona \\
    --region eu \\
    --model anthropic/claude-sonnet-4.5 \\
    --worker-path new-session \\
    --workspace-path not-observed \\
    --runs 10

Authentication (choose one):
  KORTIX_BENCH_JWT=<jwt>
  --jwt-file /absolute/path/to/jwt.txt
  --jwt <jwt>                         legacy; visible in the process list

Lifecycle values:
  --worker-path     new-session | resume
  --workspace-path  not-observed | same-runtime | cold-create |
                    already-running | resume

Required configuration:
  --agent <name>        agent selected at creation, or verified before resume
  --base-ref <ref>      configuration ref selected at creation, or verified before resume
  --session <uuid>      stopped benchmark session; required only for resume

Options:
  --tool               require a completed bash result containing ${TOOL_SENTINEL}
  --prompt <text>       override the deterministic prompt
  --expect <text>       require this text in the completed assistant response
  --keep                do not stop benchmark sessions
  --output <path>       JSON output path (default: /tmp/ttft-<label>.json)
  --dry-run             validate and print metadata without network calls

Provider, runtime, model, and the create/resume operation are verified. Region
and environment allocation cache outcomes are operator declarations. A new
session can use a warm pool; this benchmark does not label it a cold VM start.`;
}

function parseCli(argv: readonly string[]): CliConfig {
  const declaration = parseBenchmarkDeclaration(argv);
  const runs = Number(option(argv, 'runs') ?? '10');
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
    throw new Error('--runs must be an integer from 1 through 100');
  }
  const base = required(argv, 'base').replace(/\/+$/, '');
  const project = required(argv, 'project');
  const session = option(argv, 'session');
  if (declaration.workerPath === 'resume' && !session) throw new Error('resume requires --session with a stopped benchmark session');
  if (declaration.workerPath !== 'resume' && session) throw new Error('--session is only valid for resume');
  if (declaration.workerPath === 'resume' && runs > 1 && argv.includes('--keep')) throw new Error('multiple resume runs require cleanup between runs');
  const customPrompt = option(argv, 'prompt');
  const prompt = customPrompt ?? (declaration.tool ? DEFAULT_TOOL_PROMPT : DEFAULT_PROMPT);
  const expectedText =
    option(argv, 'expect') ?? (customPrompt ? null : declaration.tool ? TOOL_SENTINEL : 'READY');
  const fileToken = option(argv, 'jwt-file');
  const jwt =
    process.env.KORTIX_BENCH_JWT?.trim() ||
    (fileToken ? readFileSync(fileToken, 'utf8').trim() : '') ||
    option(argv, 'jwt')?.trim() ||
    '';
  const safeLabel = declaration.label
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return {
    base,
    project,
    jwt,
    session,
    agent: required(argv, 'agent'),
    baseRef: required(argv, 'base-ref'),
    runs,
    keep: argv.includes('--keep'),
    dryRun: argv.includes('--dry-run'),
    output: option(argv, 'output') ?? `/tmp/ttft-${safeLabel || 'benchmark'}.json`,
    prompt,
    expectedText,
    declaration,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted.at(Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))) ?? Number.NaN
  );
}

function elapsed(t0: number): number {
  return performance.now() - t0;
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 800);
}

function responseText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const parts = (value as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

function responseModel(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const info = (value as { info?: unknown }).info;
  if (!info || typeof info !== 'object') return null;
  const provider = (info as { providerID?: unknown }).providerID;
  const model = (info as { modelID?: unknown }).modelID;
  return typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : null;
}

function responseError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const info = (value as { info?: unknown }).info;
  if (!info || typeof info !== 'object') return null;
  const error = (info as { error?: unknown }).error;
  return error ? JSON.stringify(error).slice(0, 500) : null;
}

function declaredModelMatchesObserved(declared: string, observed: string): boolean {
  return observed === declared || observed.endsWith(`/${declared}`);
}

async function jsonOrError<T>(response: Response, label: string): Promise<T> {
  const raw = await response.text();
  if (!response.ok) throw new Error(`${label} ${response.status}: ${raw.slice(0, 240)}`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON: ${raw.slice(0, 240)}`);
  }
}

async function pumpGlobalEvents(
  response: Response,
  probe: TurnEventProbe,
  t0: number,
): Promise<TurnEventObservation> {
  if (!response.ok || !response.body) {
    throw new Error(
      `global event subscription ${response.status}: ${(await response.text()).slice(0, 240)}`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    throw new Error(`global event subscription returned ${contentType || 'no content-type'}`);
  }
  const reader = response.body.getReader();
  const decoder = new JsonSseDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of decoder.push(value)) {
        probe.accept(event, elapsed(t0));
        if (probe.complete) {
          await reader.cancel().catch(() => {});
          return probe.snapshot();
        }
      }
    }
    for (const event of decoder.finish()) probe.accept(event, elapsed(t0));
    if (probe.complete) return probe.snapshot();
    throw new Error('global event stream ended before the benchmark observation completed');
  } finally {
    reader.releaseLock();
  }
}

async function fetchApiSession(config: CliConfig, sessionId: string): Promise<ApiSessionRow> {
  const response = await fetch(
    `${config.base}/projects/${encodeURIComponent(config.project)}/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { authorization: `Bearer ${config.jwt}` }, signal: AbortSignal.timeout(30_000) },
  );
  return jsonOrError<ApiSessionRow>(response, 'session read');
}

async function runtimeHealth(sandboxUrl: string, jwt: string): Promise<RuntimeHealth> {
  const response = await fetch(`${sandboxUrl.replace(/\/+$/, '')}/kortix/health`, {
    headers: { authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(15_000),
  });
  return jsonOrError<RuntimeHealth>(response, 'runtime health');
}

async function stopSession(config: CliConfig, sessionId: string): Promise<RunResult['cleanup']> {
  if (config.keep) return { kept: true };
  const t0 = performance.now();
  try {
    const response = await fetch(
      `${config.base}/projects/${encodeURIComponent(config.project)}/sessions/${encodeURIComponent(sessionId)}/stop`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.jwt}`,
          'content-type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(120_000),
      },
    );
    const durationMs = performance.now() - t0;
    if (!response.ok) {
      if (response.status === 409 && (await fetchApiSession(config, sessionId)).status === 'stopped') {
        await response.body?.cancel();
        return { kept: false, status: response.status, durationMs: elapsed(t0), alreadyStopped: true };
      }
      return {
        kept: false,
        status: response.status,
        durationMs,
        error: (await response.text()).slice(0, 300),
      };
    }
    await response.body?.cancel().catch(() => {});
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      const row = await fetchApiSession(config, sessionId);
      if (row.status === 'stopped') return { kept: false, status: response.status, durationMs: elapsed(t0) };
      await sleep(250);
    }
    return { kept: false, status: response.status, durationMs: elapsed(t0), error: 'session did not reach stopped after cleanup' };
  } catch (error) {
    return { kept: false, durationMs: performance.now() - t0, error: errorText(error) };
  }
}

async function oneRun(config: CliConfig, run: number): Promise<RunResult> {
  let t0 = performance.now();
  const result: RunResult = { run, ok: false, startedAt: new Date().toISOString() };
  let sessionId: string | undefined;
  let streamController: AbortController | undefined;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    let created: ApiSessionRow;
    let priorNativeId: string | undefined;
    if (config.declaration.workerPath === 'resume') {
      const prior = await fetchApiSession(config, config.session!);
      if (prior.status !== 'stopped') throw new Error(`resume requires stopped; observed ${prior.status}`);
      if (prior.agent_name !== config.agent || prior.base_ref !== config.baseRef) {
        throw new Error('resume configuration does not match --agent and --base-ref');
      }
      if (!prior.opencode_session_id) throw new Error('resume requires a persisted native conversation identity');
      sessionId = config.session!;
      result.statusBeforeStart = prior.status;
      t0 = performance.now();
      result.startedAt = new Date().toISOString();
      priorNativeId = prior.opencode_session_id;
      created = prior;
    } else {
      const createResponse = await fetch(`${config.base}/projects/${encodeURIComponent(config.project)}/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_name: config.agent, base_ref: config.baseRef, opencode_model: config.declaration.model, provider: config.declaration.provider }),
        signal: AbortSignal.timeout(READY_TIMEOUT_MS),
      });
      created = await jsonOrError<ApiSessionRow>(createResponse, 'session create');
      sessionId = created.session_id;
      if (!sessionId) throw new Error('session create returned no session_id');
      result.createMs = elapsed(t0);
    }
    result.sessionId = sessionId;
    const startDeadline = performance.now() + READY_TIMEOUT_MS;
    let nativeId: string | undefined;
    while (performance.now() < startDeadline) {
      const remaining = startDeadline - performance.now();
      const response = await fetch(`${config.base}/projects/${encodeURIComponent(config.project)}/sessions/${encodeURIComponent(sessionId)}/start?wait_ms=${Math.min(30000, Math.ceil(remaining))}`, {
        method: 'POST', headers: { authorization: `Bearer ${config.jwt}`, 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
      });
      const started = await jsonOrError<{ stage?: string; retriable?: boolean; opencode_session_id?: string; reason?: string; failure?: { message?: string } }>(response, 'session start');
      if (started.stage === 'ready' && started.opencode_session_id) {
        nativeId = started.opencode_session_id;
        break;
      }
      if (!started.retriable || !['starting', 'provisioning'].includes(started.stage ?? '')) {
        throw new Error(`session start is not ready: ${started.stage ?? 'unknown'} (${started.reason ?? 'no reason'}; ${started.failure?.message ?? 'no detail'})`);
      }
      await sleep(Math.min(1000, Math.max(0, startDeadline - performance.now())));
    }
    if (!nativeId) throw new Error('session start did not resolve a native conversation identity');
    if (priorNativeId && nativeId !== priorNativeId) throw new Error('resume changed the native conversation identity');
    result.startMs = elapsed(t0);
    created = await fetchApiSession(config, sessionId);
    if (created.opencode_session_id !== nativeId) throw new Error('session start did not persist the native conversation identity');
    let row: ApiSessionRow = created;
    const urlDeadline = performance.now() + READY_TIMEOUT_MS;
    while (!row.sandbox_url && performance.now() < urlDeadline) {
      await sleep(250);
      row = await fetchApiSession(config, sessionId);
      if (row.status === 'failed') throw new Error(`session entered failed: ${row.status}`);
    }
    if (!row.sandbox_url) throw new Error('session did not publish sandbox_url before timeout');
    const sandboxUrl = row.sandbox_url.replace(/\/+$/, '');

    let health: RuntimeHealth | null = null;
    let lastHealthError = '';
    const healthDeadline = performance.now() + READY_TIMEOUT_MS;
    while (performance.now() < healthDeadline) {
      try {
        const candidate = await runtimeHealth(sandboxUrl, config.jwt);
        if (candidate.runtimeReady === true) {
          health = candidate;
          break;
        }
        lastHealthError = 'runtimeReady=false';
      } catch (error) {
        lastHealthError = errorText(error);
      }
      await sleep(250);
    }
    if (!health) throw new Error(`runtime did not become ready: ${lastHealthError || 'timeout'}`);
    result.readyMs = elapsed(t0);
    result.runtimeHealth = health;

    row = await fetchApiSession(config, sessionId);
    result.sessionReadMs = elapsed(t0);
    result.provider = row.sandbox_provider ?? created.sandbox_provider ?? null;
    result.warmMarkerAtRead = typeof row.metadata?.warm === 'boolean' ? row.metadata.warm : null;
    if (!result.provider) throw new Error('session read returned no sandbox_provider');
    if (result.provider.toLowerCase() !== config.declaration.provider) {
      throw new Error(
        `provider mismatch: declared ${config.declaration.provider}, observed ${result.provider}`,
      );
    }
    const observedRuntime = health.engine ?? (health.opencode === 'ok' ? 'opencode' : null);
    if (observedRuntime !== config.declaration.runtime) {
      throw new Error(
        `runtime mismatch: declared ${config.declaration.runtime}, observed ${observedRuntime ?? 'unknown'}`,
      );
    }

    const listResponse = await fetch(`${sandboxUrl}/session`, {
      headers: { authorization: `Bearer ${config.jwt}` },
      signal: AbortSignal.timeout(60_000),
    });
    const sessions = await jsonOrError<Array<{ id?: unknown }>>(
      listResponse,
      'runtime session list',
    );
    const pinnedId = row.opencode_session_id ?? health.opencode_session_id ?? null;
    const runtimeSessionId = selectRuntimeSessionId(sessions, pinnedId);
    result.runtimeSessionId = runtimeSessionId;
    result.sessionDiscoveryMs = elapsed(t0);

    streamController = new AbortController();
    streamTimer = setTimeout(
      () =>
        streamController.abort(
          new Error(`global event observation exceeded ${TURN_TIMEOUT_MS} ms`),
        ),
      TURN_TIMEOUT_MS,
    );
    result.eventRequestMs = elapsed(t0);
    const eventResponse = await fetch(`${sandboxUrl}/global/event`, {
      headers: { authorization: `Bearer ${config.jwt}` },
      signal: streamController.signal,
    });
    result.eventResponseMs = elapsed(t0);
    const messageId = mintBenchmarkMessageId();
    const probe = new TurnEventProbe(
      runtimeSessionId,
      messageId,
      config.declaration.tool,
      TOOL_SENTINEL,
    );
    let eventError: unknown = null;
    const observationPromise = pumpGlobalEvents(eventResponse, probe, t0).catch((error) => {
      eventError = error;
      return probe.snapshot();
    });

    result.messageRequestMs = elapsed(t0);
    const messageResponse = await fetch(
      `${sandboxUrl}/session/${encodeURIComponent(runtimeSessionId)}/message`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.jwt}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messageID: messageId,
          parts: [{ type: 'text', text: config.prompt }],
        }),
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      },
    );
    result.messageResponseMs = elapsed(t0);
    const assistant = await jsonOrError<unknown>(messageResponse, 'session message');
    result.responseText = responseText(assistant);
    const assistantError = responseError(assistant);
    if (assistantError) throw new Error(assistantError);

    const observation = await observationPromise;
    clearTimeout(streamTimer);
    streamTimer = undefined;
    streamController.abort();
    streamController = undefined;
    if (eventError) throw eventError;
    result.firstTokenMs = observation.firstTokenMs;
    result.firstToolResultMs = observation.firstToolResultMs;
    result.assistantMessageIds = observation.assistantMessageIds;
    result.eventCount = observation.eventCount;
    const responseModelId = responseModel(assistant);
    result.observedModels = [
      ...new Set([...observation.observedModels, ...(responseModelId ? [responseModelId] : [])]),
    ];
    if (observation.terminalError) throw new Error(observation.terminalError);
    if (result.firstTokenMs === undefined) {
      throw new Error('global event stream produced no assistant text event');
    }
    if (config.declaration.tool && result.firstToolResultMs === undefined) {
      throw new Error(`global event stream produced no completed ${TOOL_SENTINEL} tool result`);
    }
    if (config.expectedText && !result.responseText.includes(config.expectedText)) {
      throw new Error(
        `assistant response did not contain expected text ${JSON.stringify(config.expectedText)}`,
      );
    }
    if (result.observedModels.length === 0) {
      throw new Error('assistant response and events exposed no providerID/modelID');
    }
    if (
      !result.observedModels.every((model) =>
        declaredModelMatchesObserved(config.declaration.model, model),
      )
    ) {
      throw new Error(
        `model mismatch: declared ${config.declaration.model}, observed ${result.observedModels.join(', ')}`,
      );
    }

    const timeline =
      (row.metadata?.session_start_timeline as { totalMs?: unknown } | undefined)?.totalMs ??
      row.session_start_timeline?.totalMs ??
      null;
    result.serverTimelineMs = typeof timeline === 'number' ? timeline : null;
    result.totalMs = elapsed(t0);
    result.ok = true;
  } catch (error) {
    result.error = errorText(error);
    result.totalMs = elapsed(t0);
  } finally {
    if (streamTimer) clearTimeout(streamTimer);
    streamController?.abort();
    if (sessionId) result.cleanup = await stopSession(config, sessionId);
  }
  return result;
}

function formatSeconds(value?: number): string {
  return value === undefined ? '      -' : `${(value / 1000).toFixed(2)}s`.padStart(7);
}

async function apiHealth(config: CliConfig): Promise<Record<string, unknown>> {
  const response = await fetch(`${config.base}/health`, { signal: AbortSignal.timeout(30_000) });
  const health = await jsonOrError<Record<string, unknown>>(response, 'API health');
  return {
    environment: health.environment ?? null,
    version: health.version ?? null,
    commit: health.commit ?? null,
    started_at: health.started_at ?? null,
    instance: health.instance ?? null,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const config = parseCli(argv);
  const metadata = {
    schemaVersion: 2,
    benchmark: 'kortix-session-ttft',
    declaration: config.declaration,
    protocol: {
      lifecycle: config.declaration.workerPath === 'resume'
        ? 'POST /projects/:projectId/sessions/:sessionId/start'
        : 'POST /projects/:projectId/sessions',
      readiness: 'POST /projects/:projectId/sessions/:sessionId/start until ready with a persisted native identity, then GET /kortix/health',
      sessionDiscovery: 'GET /session',
      events: 'GET /global/event',
      message: 'POST /session/:sessionId/message',
      clock: `external monotonic wall clock starting before ${config.declaration.workerPath === 'resume' ? 'session start' : 'session creation'}`,
      firstToken: 'first non-empty assistant text part/delta on /global/event',
      firstToolResult: `completed tool part containing ${TOOL_SENTINEL}`,
    },
    evidence: {
      provider: 'verified against project session sandbox_provider for every usable run',
      runtime: 'verified against /kortix/health engine or a ready OpenCode daemon; unknown runtime fails',
      model: 'verified against assistant providerID/modelID for every usable run',
      configuration: 'agent and base ref selected on creation; verified against the stopped session before resume',
      region: 'operator-declared; the session API does not expose provider region',
      workerPath: 'new-session creates a session; resume verifies stopped then calls start with the same native conversation identity; allocation cache outcome is unknown',
      workspacePath: 'operator-declared; the session API does not expose allocation cache outcome',
    },
    comparability: {
      fixedDimensions: ['provider', 'region', 'model'],
      pathDimensions: ['runtime', 'workerPath', 'workspacePath', 'tool'],
      rule: 'Compare two outputs only when all fixed dimensions match. Always report every path dimension.',
    },
    target: { base: config.base, project: config.project, agent: config.agent, baseRef: config.baseRef, session: config.session ?? null },
  };

  if (config.dryRun) {
    console.log(JSON.stringify({ ...metadata, dryRun: true }, null, 2));
    return;
  }
  if (!config.jwt) throw new Error('missing KORTIX_BENCH_JWT, --jwt-file, or --jwt');

  const targetHealth = await apiHealth(config);
  const results: RunResult[] = [];
  console.log(`\n=== ${config.declaration.label} — ${config.runs} runs against ${config.base} ===`);
  console.log(
    `declared provider=${config.declaration.provider} region=${config.declaration.region} ` +
      `model=${config.declaration.model}`,
  );
  console.log(
    `path runtime=${config.declaration.runtime} worker=${config.declaration.workerPath} ` +
      `workspace=${config.declaration.workspacePath}`,
  );
  console.log('region and environment allocation cache outcomes are operator declarations; new-session does not mean a cold VM.');
  console.log(
    `run  ${config.declaration.workerPath === 'resume' ? 'start ' : 'create'}    ready     send    TOKEN   ${config.declaration.tool ? ' TOOL    ' : ''}done     status`,
  );

  for (let run = 1; run <= config.runs; run++) {
    const result = await oneRun(config, run);
    results.push(result);
    console.log(
      `${String(run).padStart(3)}  ${formatSeconds(result.createMs ?? result.startMs)}  ` +
        `${formatSeconds(result.readyMs)}  ${formatSeconds(result.messageRequestMs)}  ` +
        `${formatSeconds(result.firstTokenMs)}  ` +
        `${config.declaration.tool ? `${formatSeconds(result.firstToolResultMs)}  ` : ''}` +
        `${formatSeconds(result.messageResponseMs)}  ` +
        `${result.ok ? 'ok' : `FAIL ${result.error ?? 'unknown error'}`}`,
    );
  }

  const usable = results.filter(
    (result): result is RunResult & { firstTokenMs: number; readyMs: number } =>
      result.ok && result.firstTokenMs !== undefined && result.readyMs !== undefined,
  );
  const tokenTimes = usable.map((result) => result.firstTokenMs);
  const readyTimes = usable.map((result) => result.readyMs);
  const toolTimes = usable
    .map((result) => result.firstToolResultMs)
    .filter((value): value is number => value !== undefined);
  const observedProviders = [...new Set(results.map((result) => result.provider).filter(Boolean))];
  const observedModels = [...new Set(results.flatMap((result) => result.observedModels ?? []))];
  const cleanupFailures = results.filter((result) => result.cleanup?.error).length;
  const summary = {
    runs: results.length,
    usable: usable.length,
    failed: results.length - usable.length,
    cleanupFailures,
    observedProviders,
    observedModels,
    readyMs:
      usable.length > 0
        ? {
            p50: percentile(readyTimes, 50),
            p95: percentile(readyTimes, 95),
            min: Math.min(...readyTimes),
            max: Math.max(...readyTimes),
          }
        : null,
    firstTokenMs:
      usable.length > 0
        ? {
            p50: percentile(tokenTimes, 50),
            p95: percentile(tokenTimes, 95),
            min: Math.min(...tokenTimes),
            max: Math.max(...tokenTimes),
          }
        : null,
    firstToolResultMs:
      toolTimes.length > 0
        ? {
            p50: percentile(toolTimes, 50),
            p95: percentile(toolTimes, 95),
            min: Math.min(...toolTimes),
            max: Math.max(...toolTimes),
          }
        : null,
  };

  console.log(`\n--- ${config.declaration.label} ---`);
  console.log(
    `runs ${summary.runs}; usable ${summary.usable}; failed ${summary.failed}; cleanup failures ${summary.cleanupFailures}`,
  );
  if (summary.firstTokenMs && summary.readyMs) {
    console.log(
      `TTFT p50 ${(summary.firstTokenMs.p50 / 1000).toFixed(2)}s; ` +
        `p95 ${(summary.firstTokenMs.p95 / 1000).toFixed(2)}s; ` +
        `ready p50 ${(summary.readyMs.p50 / 1000).toFixed(2)}s`,
    );
  }
  if (summary.firstToolResultMs) {
    console.log(
      `first tool result p50 ${(summary.firstToolResultMs.p50 / 1000).toFixed(2)}s; ` +
        `p95 ${(summary.firstToolResultMs.p95 / 1000).toFixed(2)}s`,
    );
  }

  const output = {
    ...metadata,
    recordedAt: new Date().toISOString(),
    apiHealth: targetHealth,
    summary,
    results,
  };
  await writeFile(config.output, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  console.log(`raw: ${config.output}`);

  if (summary.failed > 0 || summary.cleanupFailures > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\nTTFT BENCH FAILED: ${errorText(error)}`);
    console.error(`\n${usage()}`);
    process.exitCode = 1;
  });
}
