import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ciResourceName,
  isExactCiSandbox,
  isRetryableCiError,
  pollCiState,
  retryCiOperation,
} from './ci-shared';
import { PREVIEW_HOST_RAM_MB } from './preview-session-reaper';

// v15 / v13: templates are captured at PREVIEW_HOST_RAM_MB. Platinum refuses a
// sandbox with less RAM than its template was captured with ("ram_mb=8192 is
// below the template minimum (16384)"), and the template names hash only the
// lockfile — so a RAM change must bump both versions or the 16 GB templates
// are reused.
export const PLATINUM_CI_TEMPLATE_VERSION = 'v15';
const PLATINUM_CI_BASE_TEMPLATE_VERSION = 'v13';
export const PLATINUM_CI_NODE_IMAGE =
  'node:22.22.2-bookworm@sha256:62e4daa6819762bbd3072af77cc282ab72c631c4aed30dd7980192babaf385b3';
export const PLATINUM_CI_BUN_VERSION = '1.3.14';
export const PLATINUM_CI_PNPM_VERSION = '8.11.0';
export const CI_DOCKER_COMPOSE_VERSION = 'v2.40.3';
export const CI_DOCKER_COMPOSE_AMD64_SHA256 =
  'dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372';

const POLL_MS = 3_000;
const TEMPLATE_TIMEOUT_MS = 45 * 60_000;
const WARM_PREPARE_TIMEOUT_MS = 45 * 60_000;
export const PLATINUM_CI_WARM_TIMEOUT_MS = 2 * 60_000;
const SANDBOX_START_TIMEOUT_MS = 45 * 60_000;
const WORKER_TIMEOUT_MS = 3 * 60 * 60_000;
const LOG_CHUNK_BYTES = 1024 * 1024;
const CLEANUP_MAX_ATTEMPTS = 8;
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504, 524]);
const WARM_READY_COMMAND =
  'test -s /workspace/.kortix-ci-warm-ready && ! pgrep -x dockerd >/dev/null && test ! -S /var/run/docker.sock';

interface PlatinumTemplateSpec {
  name: string;
  version: string;
  base_image: string;
  steps: Array<
    | { op: 'run'; cmd: string }
    | { op: 'env'; key: string; value: string }
    | { op: 'kernel_modules'; profile: 'container' }
  >;
  entrypoint: string;
  default_cpu: number;
  default_ram_mb: number;
  default_disk_gb: number;
  size_mb: number;
}

export interface PlatinumTemplate {
  id: string;
  name?: string;
  state?: string;
  build_logs?: string;
  buildLogs?: string;
}

export class PlatinumHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PlatinumHttpError';
  }
}

export function isRetryablePlatinumError(error: unknown): boolean {
  return isRetryableCiError(error, {
    status: error instanceof PlatinumHttpError ? error.status : undefined,
    message: error instanceof PlatinumHttpError ? error.message : undefined,
    transientStatuses: TRANSIENT_STATUS_CODES,
    abort: { status: 500, pattern: /operation was aborted/i },
  });
}

export async function retryPlatinumOperation<T>(input: {
  label: string;
  operation: () => Promise<T>;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  return retryCiOperation({
    ...input,
    isRetryableError: isRetryablePlatinumError,
    logPrefix: 'platinum-ci',
  });
}

export function selectReusablePlatinumTemplate(
  templates: PlatinumTemplate[],
  name: string,
): PlatinumTemplate | null {
  return (
    templates.find(
      (template) =>
        template.name === name &&
        ['ready', 'building'].includes(String(template.state ?? '').toLowerCase()),
    ) ?? null
  );
}

export function platinumTemplateCreateIdempotencyKey(
  name: string,
  templates: PlatinumTemplate[],
): string {
  const failedIds = templates
    .filter(
      (template) =>
        template.name === name && String(template.state ?? '').toLowerCase() === 'failed',
    )
    .map((template) => template.id)
    .sort();
  if (failedIds.length === 0) return `kortix-ci-template-${name}`;
  const failureSet = createHash('sha256').update(failedIds.join('\n')).digest('hex').slice(0, 12);
  return `kortix-ci-template-${name}-retry-${failureSet}`;
}

export interface PlatinumSandbox {
  id: string;
  name?: string;
  state?: string;
  via?: 'restore' | 'cold-boot';
  metadata?: Record<string, unknown>;
  errorMessage?: string | null;
  exposed?: Array<{ port: number; url: string; token?: string; public?: boolean }>;
}

interface PlatinumSandboxPage {
  rows: PlatinumSandbox[];
  total: number;
  has_more?: boolean;
}

interface PlatinumExecResult {
  result?: {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    error?: string;
  };
  error?: string;
}

interface FileStat {
  ok?: boolean;
  size?: number;
}

interface PlatinumWorkerObserverInput {
  startedAt: number;
  checkExitCode: () => Promise<number | null>;
  statLog: () => Promise<FileStat | null>;
  readLog: (offset: number, limit: number) => Promise<Uint8Array>;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  write?: (chunk: string) => void;
  warn?: (message: string) => void;
}

export function platinumTemplateName(lockHash: string): string {
  return ciResourceName({ flavour: PLATINUM_CI_TEMPLATE_VERSION, lockHash });
}

export function platinumBaseTemplateName(lockHash: string): string {
  return ciResourceName({
    flavour: PLATINUM_CI_BASE_TEMPLATE_VERSION,
    lockHash,
    suffix: '-base',
  });
}

export function dockerComposeInstallCommand(): string {
  const plugin = '/usr/local/lib/docker/cli-plugins/docker-compose';
  const url = `https://github.com/docker/compose/releases/download/${CI_DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64`;
  return [
    'install -d /usr/local/lib/docker/cli-plugins',
    `curl -fsSL ${url} -o ${plugin}`,
    `echo '${CI_DOCKER_COMPOSE_AMD64_SHA256}  ${plugin}' | sha256sum -c -`,
    `chmod 0755 ${plugin}`,
    'docker compose version',
  ].join(' && ');
}

function platinumWarmEntrypoint(): string {
  return [
    'set -eux',
    'exec >>/workspace/kortix-template-warm.log 2>&1',
    'cd /workspace/suna',
    'rm -f /workspace/.kortix-ci-warm-ready /var/run/docker.pid /var/run/docker.sock',
    'modprobe overlay',
    'modprobe bridge',
    'modprobe br_netfilter',
    'modprobe veth',
    'modprobe nf_tables',
    'modprobe ip_tables',
    'modprobe iptable_nat',
    'dockerd --host=unix:///var/run/docker.sock >/workspace/kortix-template-dockerd.log 2>&1 &',
    "timeout 180 sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'",
    'docker info >/dev/null',
    "timeout 2400 sh -c 'until pnpm exec supabase start --ignore-health-check; do sleep 30; done'",
    'docker image ls -q | sort -u | wc -l > /workspace/.kortix-ci-warm-ready',
    "grep -Eq '^[1-9][0-9]*$' /workspace/.kortix-ci-warm-ready",
    'docker image ls --digests',
    'pnpm exec supabase stop --no-backup',
    'pkill -TERM -x dockerd',
    "timeout 60 sh -c 'while pgrep -x dockerd >/dev/null; do sleep 1; done'",
    'rm -f /var/run/docker.pid /var/run/docker.sock',
    'exec sleep infinity',
  ].join('\n');
}

export function buildPlatinumTemplateSpec(input: {
  lockHash: string;
  repository: string;
  cacheSha: string;
}): PlatinumTemplateSpec {
  const name = platinumBaseTemplateName(input.lockHash);
  const cacheCommand = [
    'set -eux',
    'mkdir -p /workspace /root/.cache/ms-playwright',
    'rm -rf /workspace/suna',
    'git init /workspace/suna',
    'git -C /workspace/suna remote add origin https://github.com/' + input.repository + '.git',
    'git -C /workspace/suna fetch --depth=1 origin ' + input.cacheSha,
    'git -C /workspace/suna checkout --detach FETCH_HEAD',
    'test "$(git -C /workspace/suna rev-parse HEAD)" = "' + input.cacheSha + '"',
    'cd /workspace/suna',
    'corepack enable',
    'pnpm install --frozen-lockfile',
    'pnpm --dir tests exec playwright install --with-deps chromium',
    'rm -rf /workspace/suna/tests/test-results',
  ].join(' && ');

  return {
    name,
    version: '1.0.0',
    base_image: PLATINUM_CI_NODE_IMAGE,
    steps: [
      { op: 'kernel_modules', profile: 'container' },
      {
        op: 'run',
        cmd: [
          'set -eux',
          'export DEBIAN_FRONTEND=noninteractive',
          'apt-get update',
          'apt-get install -y --no-install-recommends ca-certificates curl docker.io git jq procps ripgrep unzip xz-utils',
          dockerComposeInstallCommand(),
          'rm -rf /var/lib/apt/lists/*',
          `npm install --global bun@${PLATINUM_CI_BUN_VERSION}`,
          `corepack prepare pnpm@${PLATINUM_CI_PNPM_VERSION} --activate`,
        ].join(' && '),
      },
      { op: 'run', cmd: cacheCommand },
      { op: 'env', key: 'KORTIX_PLATINUM_CI_TEMPLATE', value: name },
    ],
    entrypoint: platinumWarmEntrypoint(),
    default_cpu: 8,
    default_ram_mb: PREVIEW_HOST_RAM_MB,
    default_disk_gb: 50,
    size_mb: 20_480,
  };
}

export function buildPlatinumWarmTemplateRequest(lockHash: string): {
  name: string;
  capture_condition: { cmd: string; timeoutSec: number };
  default_cpu: number;
  default_ram_mb: number;
  default_disk_gb: number;
} {
  return {
    name: platinumTemplateName(lockHash),
    capture_condition: {
      cmd: WARM_READY_COMMAND,
      timeoutSec: WARM_PREPARE_TIMEOUT_MS / 1000,
    },
    default_cpu: 8,
    default_ram_mb: PREVIEW_HOST_RAM_MB,
    default_disk_gb: 50,
  };
}

export class PlatinumApi {
  readonly base: string;
  readonly headers: Record<string, string>;

  constructor(apiUrl: string, apiKey: string) {
    this.base = apiUrl.replace(/\/+$/, '');
    this.headers = { authorization: `Bearer ${apiKey}` };
  }

  async json<T>(
    path: string,
    init: RequestInit = {},
    retryOptions: { attempts?: number; retry?: boolean } = {},
  ): Promise<T> {
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = {
      ...this.headers,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    };
    const retryable =
      retryOptions.retry ??
      (['GET', 'PUT', 'DELETE'].includes(method) || new Headers(headers).has('idempotency-key'));
    const operation = async () => {
      const response = await fetch(`${this.base}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(310_000),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new PlatinumHttpError(
          `Platinum ${method} ${path} -> ${response.status}: ${body}`,
          response.status,
        );
      }
      return (body ? JSON.parse(body) : null) as T;
    };
    return retryable
      ? retryPlatinumOperation({
          label: `${method} ${path}`,
          operation,
          attempts: retryOptions.attempts,
        })
      : operation();
  }

  async write(path: string, data: string, mode = '0644'): Promise<void> {
    await retryPlatinumOperation({
      label: 'PUT sandbox file',
      operation: async () => {
        const response = await fetch(
          `${this.base}/v1/sandboxes/${path.split(':', 1)[0]}/files?path=${encodeURIComponent(path.slice(path.indexOf(':') + 1))}&mode=${mode}`,
          {
            method: 'PUT',
            headers: this.headers,
            body: data,
            signal: AbortSignal.timeout(60_000),
          },
        );
        if (!response.ok) {
          throw new PlatinumHttpError(
            `Platinum file write -> ${response.status}: ${await response.text()}`,
            response.status,
          );
        }
      },
    });
  }

  async read(
    sandboxId: string,
    path: string,
    offset?: number,
    limit?: number,
    attempts?: number,
  ): Promise<Uint8Array> {
    const query = new URLSearchParams({ path });
    if (offset !== undefined) query.set('offset', String(offset));
    if (limit !== undefined) query.set('limit', String(limit));
    return retryPlatinumOperation({
      label: `GET sandbox file ${path}`,
      operation: async () => {
        const response = await fetch(`${this.base}/v1/sandboxes/${sandboxId}/files?${query}`, {
          headers: this.headers,
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          throw new PlatinumHttpError(
            `Platinum file read ${path} -> ${response.status}: ${await response.text()}`,
            response.status,
          );
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      attempts,
    });
  }
}

export function selectOutstandingPlatinumSandboxIds(
  sandboxes: PlatinumSandbox[],
  runId: string,
  runAttempt: string,
): string[] {
  const expectedName = `kortix-ci-${runId}-${runAttempt}`.slice(0, 64);
  return sandboxes
    .filter((sandbox) =>
      isExactCiSandbox({
        name: sandbox.name,
        owner: sandbox.metadata?.owner,
        runId: sandbox.metadata?.run_id,
        expectedName,
        expectedOwner: 'kortix-ci',
        expectedRunId: runId,
      }),
    )
    .map((sandbox) => sandbox.id);
}

export async function cleanupPlatinumCiSandboxes(input: {
  apiUrl: string;
  apiKey: string;
  runId: string;
  runAttempt: string;
}): Promise<number> {
  if (!input.apiKey) throw new Error('PLATINUM_API_KEY is required');
  if (!/^https:\/\//.test(input.apiUrl)) throw new Error('PLATINUM_API_URL must use https');
  if (!/^[a-z0-9_.-]+$/i.test(input.runId)) throw new Error(`invalid run id: ${input.runId}`);
  if (!/^[a-z0-9_.-]+$/i.test(input.runAttempt)) {
    throw new Error(`invalid run attempt: ${input.runAttempt}`);
  }

  const api = new PlatinumApi(input.apiUrl, input.apiKey);
  const sandboxes: PlatinumSandbox[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await api.json<PlatinumSandboxPage>(
      `/v1/sandboxes?paginated=true&limit=${limit}&offset=${offset}`,
    );
    sandboxes.push(...page.rows);
    if (!page.has_more || page.rows.length === 0) break;
  }
  const ids = selectOutstandingPlatinumSandboxIds(sandboxes, input.runId, input.runAttempt);
  for (const id of ids) {
    try {
      await api.json(
        `/v1/sandboxes/${id}`,
        { method: 'DELETE', signal: AbortSignal.timeout(30_000) },
        { attempts: CLEANUP_MAX_ATTEMPTS },
      );
    } catch (error) {
      if (!(error instanceof PlatinumHttpError && error.status === 404)) throw error;
    }
    console.log(`[platinum-ci] post_deleted sandbox=${id}`);
  }
  if (ids.length === 0) console.log('[platinum-ci] post_cleanup sandbox=none');
  return ids.length;
}

async function waitForTemplate(
  api: PlatinumApi,
  template: PlatinumTemplate,
): Promise<PlatinumTemplate> {
  const health = observationHealth(
    'template status unavailable',
    'template polling recovered',
    console.warn,
  );
  return pollCiState({
    read: async () => {
      const current = await api.json<PlatinumTemplate>(`/v1/templates/${template.id}`);
      health.recover();
      return current;
    },
    onTransientError: (error) => {
      if (!isRetryablePlatinumError(error)) throw error;
      health.fail(error);
    },
    ready: (state) => state === 'ready',
    terminal: (current, state) =>
      state === 'failed'
        ? new Error(
            `Platinum template ${current.id} failed: ${current.build_logs ?? current.buildLogs ?? ''}`,
          )
        : null,
    log: (current, state) => {
      console.log(`[platinum-ci] template=${current.name ?? current.id} state=${state}`);
    },
    timeoutError: () =>
      new Error(
        `Platinum template ${template.id} did not become ready within ${TEMPLATE_TIMEOUT_MS}ms`,
      ),
    startAt: Date.now(),
    timeoutMs: TEMPLATE_TIMEOUT_MS,
    pollMs: POLL_MS,
    sleep: Bun.sleep,
  });
}

export async function ensureTemplate(
  api: PlatinumApi,
  spec: PlatinumTemplateSpec,
): Promise<PlatinumTemplate> {
  const templates = await api.json<PlatinumTemplate[]>(
    `/v1/templates?name=${encodeURIComponent(spec.name)}&limit=20`,
    {},
    { attempts: 20 },
  );
  const existing = selectReusablePlatinumTemplate(templates, spec.name);
  if (existing) {
    console.log(`[platinum-ci] template=${spec.name} cache=hit id=${existing.id}`);
    return waitForTemplate(api, existing);
  }
  console.log(`[platinum-ci] template=${spec.name} cache=miss`);
  const queued = await api.json<PlatinumTemplate>('/v1/templates/from-spec', {
    method: 'POST',
    headers: { 'idempotency-key': platinumTemplateCreateIdempotencyKey(spec.name, templates) },
    body: JSON.stringify(spec),
  });
  return waitForTemplate(api, queued);
}

export async function ensureWarmTemplate(
  api: PlatinumApi,
  base: PlatinumTemplate,
  lockHash: string,
): Promise<PlatinumTemplate> {
  const name = platinumTemplateName(lockHash);
  const templates = await api.json<PlatinumTemplate[]>(
    `/v1/templates?name=${encodeURIComponent(name)}&limit=20`,
    {},
    { attempts: 20 },
  );
  const existing = selectReusablePlatinumTemplate(templates, name);
  if (existing) {
    console.log(`[platinum-ci] template=${name} cache=hit id=${existing.id}`);
    return waitForTemplate(api, existing);
  }
  console.log(`[platinum-ci] template=${name} cache=miss parent=${base.id}`);
  const derived = await api.json<PlatinumTemplate>(`/v1/templates/${base.id}/derive`, {
    method: 'POST',
    headers: { 'idempotency-key': platinumTemplateCreateIdempotencyKey(name, templates) },
    body: JSON.stringify(buildPlatinumWarmTemplateRequest(lockHash)),
  });
  return waitForTemplate(api, derived);
}

export async function observePlatinumSandboxStart(input: {
  sandbox: PlatinumSandbox;
  startedAt: number;
  readSandbox: () => Promise<PlatinumSandbox>;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  write?: (state: string, sandbox: PlatinumSandbox) => void;
}): Promise<PlatinumSandbox> {
  const write =
    input.write ??
    ((state: string, sandbox: PlatinumSandbox) => {
      console.log(
        `[platinum-ci] sandbox=${sandbox.id} state=${state} via=${sandbox.via ?? 'unknown'}`,
      );
    });
  const terminalStates = new Set(['archived', 'deleted', 'error', 'failed', 'stopped']);
  const health = observationHealth(
    'sandbox status unavailable',
    'sandbox polling recovered',
    console.warn,
  );
  return pollCiState({
    initial: input.sandbox,
    read: async (previous) => {
      const observed = await input.readSandbox();
      const current = previous ?? input.sandbox;
      const merged = { ...current, ...observed, via: observed.via ?? current.via };
      health.recover();
      return merged;
    },
    onTransientError: (error) => {
      if (!isRetryablePlatinumError(error)) throw error;
      health.fail(error);
    },
    ready: (state) => state === 'running',
    terminal: (current, state) =>
      terminalStates.has(state)
        ? new Error(
            `Platinum worker ${current.id} entered state=${state}: ${current.errorMessage ?? ''}`,
          )
        : null,
    log: (current, state) => {
      write(state, current);
    },
    timeoutError: () =>
      new Error(
        `Platinum worker ${input.sandbox.id} did not become running within ${input.timeoutMs ?? SANDBOX_START_TIMEOUT_MS}ms`,
      ),
    startAt: input.startedAt,
    timeoutMs: input.timeoutMs ?? SANDBOX_START_TIMEOUT_MS,
    pollMs: input.pollMs ?? POLL_MS,
    now: input.now,
    sleep: input.sleep ?? Bun.sleep,
  });
}

export function platinumWarmReadinessTimeoutMs(via: PlatinumSandbox['via']): number {
  return via === 'cold-boot' ? WARM_PREPARE_TIMEOUT_MS : PLATINUM_CI_WARM_TIMEOUT_MS;
}

export async function waitForWarmSandbox(
  api: PlatinumApi,
  sandboxId: string,
  timeoutMs = PLATINUM_CI_WARM_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // No recovery warn exists on this path today: the absent marker resets the
  // counter silently, so the recovered label stays unused here.
  const health = observationHealth('warm marker unavailable', '', console.warn);
  while (Date.now() < deadline) {
    try {
      if (await stat(api, sandboxId, '/workspace/.kortix-ci-warm-ready', 1)) {
        const ready = await exec(api, sandboxId, ['bash', '-lc', WARM_READY_COMMAND], true);
        if (ready.exit_code !== 0) {
          await Bun.sleep(POLL_MS);
          continue;
        }
        const marker = new TextDecoder()
          .decode(
            await api.read(sandboxId, '/workspace/.kortix-ci-warm-ready', undefined, undefined, 1),
          )
          .trim();
        console.log(`[platinum-ci] warm_sandbox_ready=1 ${marker}`);
        return;
      }
      health.reset();
    } catch (error) {
      if (!isRetryablePlatinumError(error)) throw error;
      health.fail(error);
    }
    await Bun.sleep(POLL_MS);
  }
  let warmLog = '';
  try {
    warmLog = new TextDecoder().decode(
      await api.read(sandboxId, '/workspace/kortix-template-warm.log', undefined, undefined, 1),
    );
  } catch {
    // The log is optional. The missing marker is the authoritative failure.
  }
  throw new Error(
    `Platinum sandbox ${sandboxId} did not become warm within ${timeoutMs}ms\n${warmLog.slice(-20_000)}`,
  );
}

export async function exec(
  api: PlatinumApi,
  sandboxId: string,
  command: string[],
  retry = false,
): Promise<NonNullable<PlatinumExecResult['result']>> {
  const response = await api.json<PlatinumExecResult>(
    `/v1/sandboxes/${sandboxId}/exec`,
    {
      method: 'POST',
      body: JSON.stringify({ cmd: command, timeout_ms: 300_000 }),
    },
    { retry },
  );
  if (response.error) throw new Error(response.error);
  if (response.result?.error) throw new Error(response.result.error);
  if (!response.result) throw new Error('Platinum exec response did not include a result');
  return response.result;
}

export async function stat(
  api: PlatinumApi,
  sandboxId: string,
  path: string,
  attempts?: number,
): Promise<FileStat | null> {
  try {
    return await api.json<FileStat>(
      `/v1/sandboxes/${sandboxId}/files/stat?path=${encodeURIComponent(path)}`,
      {},
      { attempts },
    );
  } catch (error) {
    if (String(error).includes('-> 404:')) return null;
    throw error;
  }
}

/**
 * The observation-failure bookkeeping shared by every platinum-ci poll: a
 * failure counter whose increments are gated by the report-once-then-every-10
 * rule, a recovery warn that clears the counter, and a silent reset.
 */
function observationHealth(
  unavailableLabel: string,
  recoveredLabel: string,
  warn: (message: string) => void,
): {
  fail: (error: unknown) => void;
  recover: () => void;
  reset: () => void;
} {
  let failures = 0;
  const shouldReport = (count: number): boolean => count === 1 || count % 10 === 0;
  return {
    fail: (error) => {
      failures += 1;
      if (shouldReport(failures)) {
        warn(`[platinum-ci] ${unavailableLabel} failures=${failures} error=${String(error)}`);
      }
    },
    recover: () => {
      if (failures > 0) {
        warn(`[platinum-ci] ${recoveredLabel} after ${failures} failure(s)`);
        failures = 0;
      }
    },
    reset: () => {
      failures = 0;
    },
  };
}

export async function observePlatinumWorker(input: PlatinumWorkerObserverInput): Promise<number> {
  let offset = 0;
  const decoder = new TextDecoder();
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? Bun.sleep;
  const write = input.write ?? ((chunk: string) => process.stdout.write(chunk));
  const warn = input.warn ?? console.warn;
  const timeoutMs = input.timeoutMs ?? WORKER_TIMEOUT_MS;
  const pollMs = input.pollMs ?? POLL_MS;
  const deadline = input.startedAt + timeoutMs;
  const statusHealth = observationHealth(
    'worker status unavailable',
    'worker status polling recovered',
    warn,
  );
  const logHealth = observationHealth(
    'incremental log unavailable',
    'incremental log streaming recovered',
    warn,
  );

  while (now() < deadline) {
    let exitCode: number | null = null;
    try {
      exitCode = await input.checkExitCode();
      statusHealth.recover();
    } catch (error) {
      if (!isRetryablePlatinumError(error)) throw error;
      statusHealth.fail(error);
    }

    try {
      const log = await input.statLog();
      const size = Number(log?.size ?? 0);
      while (size > offset) {
        const length = Math.min(LOG_CHUNK_BYTES, size - offset);
        const bytes = await input.readLog(offset, length);
        if (bytes.byteLength === 0) break;
        write(decoder.decode(bytes, { stream: true }));
        offset += bytes.byteLength;
      }
      logHealth.recover();
    } catch (error) {
      logHealth.fail(error);
    }

    if (exitCode !== null) return exitCode;
    await sleep(pollMs);
  }
  throw new Error(`Platinum worker exceeded ${timeoutMs}ms`);
}


export async function downloadArtifacts(
  api: PlatinumApi,
  sandboxId: string,
  root: string,
): Promise<void> {
  if (!(await stat(api, sandboxId, '/workspace/kortix-test-results.tar.gz'))) {
    throw new Error('Platinum worker did not produce the required test-results artifact');
  }
  const bytes = await api.read(sandboxId, '/workspace/kortix-test-results.tar.gz');
  const outputDir = resolve(root, 'tests/test-results');
  const archive = resolve(outputDir, 'platinum-worker.tar.gz');
  await mkdir(outputDir, { recursive: true });
  await writeFile(archive, bytes);
  const extracted = Bun.spawn(['tar', '-xzf', archive, '-C', root], {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await extracted.exited;
  if (code !== 0) throw new Error(`artifact extraction exited with code ${code}`);
}

