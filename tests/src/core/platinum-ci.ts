import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export const PLATINUM_CI_TEMPLATE_VERSION = 'v2';
export const PLATINUM_CI_NODE_IMAGE =
  'node:22.22.0-bookworm@sha256:2e3d655fd1e3ffaa6b5f23ee9f3905a0fd9e8c0a65df94c8ae6e4d18a0f48870';
export const PLATINUM_CI_BUN_VERSION = '1.3.14';
export const PLATINUM_CI_PNPM_VERSION = '8.11.0';

const POLL_MS = 3_000;
const TEMPLATE_TIMEOUT_MS = 20 * 60_000;
const WORKER_TIMEOUT_MS = 3 * 60 * 60_000;
const LOG_CHUNK_BYTES = 1024 * 1024;
const API_MAX_ATTEMPTS = 6;
const CLEANUP_MAX_ATTEMPTS = 8;
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504, 524]);

export interface PlatinumCiInput {
  apiUrl: string;
  apiKey: string;
  repository: string;
  sha: string;
  ref: string;
  runId: string;
  runAttempt: string;
  testArgs: string[];
  root: string;
}

export interface PlatinumTemplateSpec {
  name: string;
  version: string;
  base_image: string;
  steps: Array<{ op: 'run'; cmd: string } | { op: 'env'; key: string; value: string }>;
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
  if (error instanceof PlatinumHttpError) return TRANSIENT_STATUS_CODES.has(error.status);
  if (error instanceof SyntaxError) return false;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /abort|connection reset|econnreset|fetch failed|network|socket|timed?\s*out/i.test(message);
}

export function platinumRetryDelayMs(attempt: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export async function retryPlatinumOperation<T>(input: {
  label: string;
  operation: () => Promise<T>;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const attempts = input.attempts ?? API_MAX_ATTEMPTS;
  const sleep = input.sleep ?? Bun.sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryablePlatinumError(error)) throw error;
      const delayMs = platinumRetryDelayMs(attempt);
      console.warn(
        `[platinum-ci] retry label=${input.label} attempt=${attempt + 1}/${attempts} delay_ms=${delayMs} error=${String(error)}`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export function selectReusablePlatinumTemplate(
  templates: PlatinumTemplate[],
  name: string,
): PlatinumTemplate | null {
  return templates.find((template) =>
    template.name === name && ['ready', 'building'].includes(String(template.state ?? '').toLowerCase())
  ) ?? null;
}

interface PlatinumSandbox {
  id: string;
  state?: string;
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

interface WorkerMetadata {
  provider: 'platinum';
  sandboxId: string;
  templateId: string;
  templateName: string;
  repository: string;
  ref: string;
  gitSha: string;
  command: string[];
  templateDurationMs: number;
  sandboxCreateDurationMs: number;
  workerDurationMs: number;
  totalDurationMs: number;
  exitCode: number;
}

export function validatePlatinumCiInput(input: PlatinumCiInput): void {
  if (!input.apiKey) throw new Error('PLATINUM_API_KEY is required');
  if (!/^https:\/\//.test(input.apiUrl)) throw new Error('PLATINUM_API_URL must use https');
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(input.repository)) {
    throw new Error(`invalid GitHub repository: ${input.repository}`);
  }
  if (!/^[a-f0-9]{40}$/i.test(input.sha)) throw new Error(`invalid Git SHA: ${input.sha}`);
  if (!/^[a-z0-9_./-]+$/i.test(input.ref)) throw new Error(`invalid Git ref: ${input.ref}`);
  if (!/^[a-z0-9_.-]+$/i.test(input.runId)) throw new Error(`invalid run id: ${input.runId}`);
  if (!/^[a-z0-9_.-]+$/i.test(input.runAttempt)) {
    throw new Error(`invalid run attempt: ${input.runAttempt}`);
  }
}

export async function lockfileHash(root: string): Promise<string> {
  const lockfile = await readFile(resolve(root, 'pnpm-lock.yaml'));
  return createHash('sha256').update(lockfile).digest('hex');
}

export function platinumTemplateName(lockHash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(lockHash)) throw new Error(`invalid lockfile hash: ${lockHash}`);
  return `kortix-ci-${PLATINUM_CI_TEMPLATE_VERSION}-${lockHash.slice(0, 16)}`;
}

export function buildPlatinumTemplateSpec(input: {
  lockHash: string;
  repository: string;
  cacheSha: string;
}): PlatinumTemplateSpec {
  const name = platinumTemplateName(input.lockHash);
  const cacheCommand = [
    'set -eux',
    'mkdir -p /opt/kortix /workspace /root/.cache/ms-playwright',
    'git init /tmp/suna-cache',
    'git -C /tmp/suna-cache remote add origin https://github.com/' + input.repository + '.git',
    'git -C /tmp/suna-cache fetch --depth=1 origin ' + input.cacheSha,
    'git -C /tmp/suna-cache checkout --detach FETCH_HEAD',
    'test "$(git -C /tmp/suna-cache rev-parse HEAD)" = "' + input.cacheSha + '"',
    'cd /tmp/suna-cache',
    'corepack enable',
    'pnpm install --frozen-lockfile',
    'pnpm --dir tests exec playwright install chromium',
    'rm -rf /tmp/suna-cache',
  ].join(' && ');

  return {
    name,
    version: '1.0.0',
    base_image: PLATINUM_CI_NODE_IMAGE,
    steps: [
      {
        op: 'run',
        cmd: [
          'set -eux',
          'export DEBIAN_FRONTEND=noninteractive',
          'apt-get update',
          'apt-get install -y --no-install-recommends ca-certificates curl docker.io git jq procps ripgrep unzip xz-utils',
          'rm -rf /var/lib/apt/lists/*',
          `npm install --global bun@${PLATINUM_CI_BUN_VERSION}`,
          `corepack prepare pnpm@${PLATINUM_CI_PNPM_VERSION} --activate`,
        ].join(' && '),
      },
      { op: 'run', cmd: cacheCommand },
      { op: 'env', key: 'KORTIX_PLATINUM_CI_TEMPLATE', value: name },
    ],
    default_cpu: 8,
    default_ram_mb: 16_384,
    default_disk_gb: 50,
    size_mb: 20_480,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildWorkerScript(input: {
  repository: string;
  ref: string;
  sha: string;
  testArgs: string[];
}): string {
  const command = ['pnpm', 'test', ...(input.testArgs.length ? ['--', ...input.testArgs] : [])];
  const testCommand = command.map(shellQuote).join(' ');
  const needsWeb = input.testArgs.includes('--full') || input.testArgs.includes('--browser-only');
  return `#!/usr/bin/env bash
set -uo pipefail

ROOT=/workspace/suna
LOG=/workspace/kortix-test.log
STATUS=/workspace/kortix-test.exit
DEV_LOG=/workspace/kortix-dev.log
ARTIFACT=/workspace/kortix-test-results.tar.gz

exec > >(tee -a "$LOG") 2>&1
rm -f "$STATUS" "$ARTIFACT"

finish() {
  local code="$1"
  set +e
  if [[ -d "$ROOT/tests/test-results" ]]; then
    tar -C "$ROOT" -czf "$ARTIFACT" tests/test-results
  fi
  printf '%s\n' "$code" > "$STATUS"
}
trap 'code=$?; finish "$code"' EXIT

echo "[platinum-ci] repository=${input.repository}"
echo "[platinum-ci] ref=${input.ref}"
echo "[platinum-ci] expected_sha=${input.sha}"
echo "[platinum-ci] command=${command.join(' ')}"

rm -rf "$ROOT"
git init "$ROOT"
git -C "$ROOT" remote add origin ${shellQuote(`https://github.com/${input.repository}.git`)}
git -C "$ROOT" fetch --depth=1 origin ${shellQuote(input.ref)}
git -C "$ROOT" checkout --detach FETCH_HEAD
actual_sha="$(git -C "$ROOT" rev-parse HEAD)"
if [[ "$actual_sha" != ${shellQuote(input.sha)} ]]; then
  echo "[platinum-ci] expected ${input.sha}, got $actual_sha" >&2
  exit 2
fi
echo "[platinum-ci] exact_sha=$actual_sha"

cd "$ROOT"
corepack enable
pnpm install --frozen-lockfile

if ! docker info >/dev/null 2>&1; then
  nohup dockerd --host=unix:///var/run/docker.sock > /workspace/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
docker info >/dev/null
echo "[platinum-ci] docker_ready=1"

${needsWeb ? `export KORTIX_SESSION_ID=platinum-ci
export KORTIX_DEV_TUNNEL=0
export KORTIX_STRIPE_LISTEN=0
nohup pnpm dev > "$DEV_LOG" 2>&1 &
for _ in $(seq 1 360); do
  if curl -fsS http://127.0.0.1:8008/v1/health >/dev/null 2>&1 && curl -fsS http://localhost:3000 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:8008/v1/health >/dev/null
curl -fsS http://localhost:3000 >/dev/null
echo "[platinum-ci] local_web_ready=1"` : ''}

${testCommand}
`;
}

export function platinumWorkerLaunchCommand(): string {
  return 'setsid -f /workspace/run-kortix-tests.sh >/workspace/kortix-bootstrap.log 2>&1 </dev/null';
}

class PlatinumApi {
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
    const retryable = retryOptions.retry ?? (
      ['GET', 'PUT', 'DELETE'].includes(method) || new Headers(headers).has('idempotency-key')
    );
    const operation = async () => {
      const response = await fetch(`${this.base}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(310_000),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new PlatinumHttpError(`Platinum ${method} ${path} -> ${response.status}: ${body}`, response.status);
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
          throw new PlatinumHttpError(`Platinum file write -> ${response.status}: ${await response.text()}`, response.status);
        }
      },
    });
  }

  async read(sandboxId: string, path: string, offset?: number, limit?: number): Promise<Uint8Array> {
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
          throw new PlatinumHttpError(`Platinum file read ${path} -> ${response.status}: ${await response.text()}`, response.status);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    });
  }
}

async function waitForTemplate(api: PlatinumApi, template: PlatinumTemplate): Promise<PlatinumTemplate> {
  const deadline = Date.now() + TEMPLATE_TIMEOUT_MS;
  let lastState = '';
  while (Date.now() < deadline) {
    const current = await api.json<PlatinumTemplate>(`/v1/templates/${template.id}`);
    const state = String(current.state ?? '').toLowerCase();
    if (state !== lastState) {
      console.log(`[platinum-ci] template=${current.name ?? current.id} state=${state}`);
      lastState = state;
    }
    if (state === 'ready') return current;
    if (state === 'failed') {
      throw new Error(`Platinum template ${current.id} failed: ${current.build_logs ?? current.buildLogs ?? ''}`);
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`Platinum template ${template.id} did not become ready within ${TEMPLATE_TIMEOUT_MS}ms`);
}

async function ensureTemplate(
  api: PlatinumApi,
  spec: PlatinumTemplateSpec,
): Promise<PlatinumTemplate> {
  const existing = selectReusablePlatinumTemplate(
    await api.json<PlatinumTemplate[]>(`/v1/templates?name=${encodeURIComponent(spec.name)}&limit=20`),
    spec.name,
  );
  if (existing) {
    console.log(`[platinum-ci] template=${spec.name} cache=hit id=${existing.id}`);
    return waitForTemplate(api, existing);
  }
  console.log(`[platinum-ci] template=${spec.name} cache=miss`);
  const queued = await api.json<PlatinumTemplate>('/v1/templates/from-spec', {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return waitForTemplate(api, queued);
}

async function exec(api: PlatinumApi, sandboxId: string, command: string[]): Promise<PlatinumExecResult['result']> {
  const response = await api.json<PlatinumExecResult>(`/v1/sandboxes/${sandboxId}/exec`, {
    method: 'POST',
    body: JSON.stringify({ cmd: command, timeout_ms: 300_000 }),
  });
  if (response.error) throw new Error(response.error);
  if (response.result?.error) throw new Error(response.result.error);
  return response.result;
}

async function stat(api: PlatinumApi, sandboxId: string, path: string): Promise<FileStat | null> {
  try {
    return await api.json<FileStat>(
      `/v1/sandboxes/${sandboxId}/files/stat?path=${encodeURIComponent(path)}`,
    );
  } catch (error) {
    if (String(error).includes('-> 404:')) return null;
    throw error;
  }
}

async function streamWorker(
  api: PlatinumApi,
  sandboxId: string,
  startedAt: number,
): Promise<number> {
  let offset = 0;
  const decoder = new TextDecoder();
  const deadline = startedAt + WORKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const log = await stat(api, sandboxId, '/workspace/kortix-test.log');
    const size = Number(log?.size ?? 0);
    while (size > offset) {
      const length = Math.min(LOG_CHUNK_BYTES, size - offset);
      const bytes = await api.read(sandboxId, '/workspace/kortix-test.log', offset, length);
      process.stdout.write(decoder.decode(bytes));
      offset += bytes.byteLength;
    }

    const status = await stat(api, sandboxId, '/workspace/kortix-test.exit');
    if (status) {
      const bytes = await api.read(sandboxId, '/workspace/kortix-test.exit');
      const exitCode = Number(decoder.decode(bytes).trim());
      if (!Number.isInteger(exitCode)) throw new Error('Platinum worker wrote an invalid exit code');
      return exitCode;
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`Platinum worker ${sandboxId} exceeded ${WORKER_TIMEOUT_MS}ms`);
}

async function downloadArtifacts(
  api: PlatinumApi,
  sandboxId: string,
  root: string,
): Promise<void> {
  if (!(await stat(api, sandboxId, '/workspace/kortix-test-results.tar.gz'))) return;
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

export async function runPlatinumCi(input: PlatinumCiInput): Promise<number> {
  validatePlatinumCiInput(input);
  const totalStartedAt = Date.now();
  const api = new PlatinumApi(input.apiUrl, input.apiKey);
  const hash = await lockfileHash(input.root);
  const templateSpec = buildPlatinumTemplateSpec({
    lockHash: hash,
    repository: input.repository,
    cacheSha: input.sha,
  });
  console.log(`[platinum-ci] template=${templateSpec.name}`);

  const templateStartedAt = Date.now();
  const template = await ensureTemplate(api, templateSpec);
  const templateDurationMs = Date.now() - templateStartedAt;

  let sandboxId = '';
  let sandboxCreateDurationMs = 0;
  let workerDurationMs = 0;
  let exitCode = 1;
  const cleanup = async () => {
    if (!sandboxId) return;
    try {
      try {
        await api.json(
          `/v1/sandboxes/${sandboxId}`,
          { method: 'DELETE', signal: AbortSignal.timeout(30_000) },
          { attempts: CLEANUP_MAX_ATTEMPTS },
        );
      } catch (error) {
        if (!(error instanceof PlatinumHttpError && error.status === 404)) throw error;
      }
      console.log(`[platinum-ci] deleted sandbox=${sandboxId}`);
    } catch (error) {
      console.error(`[platinum-ci] sandbox cleanup failed: ${String(error)}`);
      throw error;
    }
    sandboxId = '';
  };

  const onSignal = (signal: string) => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const createStartedAt = Date.now();
    const sandbox = await api.json<PlatinumSandbox>(
      '/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000',
      {
        method: 'POST',
        headers: { 'idempotency-key': `kortix-ci-${input.runId}-${input.runAttempt}` },
        body: JSON.stringify({
          name: `kortix-ci-${input.runId}-${input.runAttempt}`.slice(0, 64),
          template: template.id,
          type: 'ephemeral',
          auto_stop_minutes: 15,
          auto_archive_days: 1,
          auto_delete_days: 1,
          cpu: 8,
          ram_mb: 16_384,
          disk_gb: 50,
          metadata: {
            owner: 'kortix-ci',
            repository: input.repository,
            git_sha: input.sha,
            run_id: input.runId,
          },
        }),
      },
    );
    sandboxId = sandbox.id;
    sandboxCreateDurationMs = Date.now() - createStartedAt;
    if (String(sandbox.state).toLowerCase() !== 'running') {
      throw new Error(`Platinum worker ${sandbox.id} returned state=${sandbox.state}`);
    }
    console.log(`[platinum-ci] sandbox=${sandboxId} state=running`);

    const workerScript = buildWorkerScript(input);
    await api.write(`${sandboxId}:/workspace/run-kortix-tests.sh`, workerScript, '0755');
    const launch = await exec(api, sandboxId, [
      'bash',
      '-lc',
      platinumWorkerLaunchCommand(),
    ]);
    if ((launch?.exit_code ?? 0) !== 0) {
      throw new Error(`Platinum worker launch failed: ${launch?.stderr ?? ''}`);
    }

    const workerStartedAt = Date.now();
    exitCode = await streamWorker(api, sandboxId, workerStartedAt);
    workerDurationMs = Date.now() - workerStartedAt;
    await downloadArtifacts(api, sandboxId, input.root);

    const metadata: WorkerMetadata = {
      provider: 'platinum',
      sandboxId,
      templateId: template.id,
      templateName: templateSpec.name,
      repository: input.repository,
      ref: input.ref,
      gitSha: input.sha,
      command: ['pnpm', 'test', ...(input.testArgs.length ? ['--', ...input.testArgs] : [])],
      templateDurationMs,
      sandboxCreateDurationMs,
      workerDurationMs,
      totalDurationMs: Date.now() - totalStartedAt,
      exitCode,
    };
    const metadataDir = resolve(input.root, 'tests/test-results/platinum');
    await mkdir(metadataDir, { recursive: true });
    await writeFile(
      resolve(metadataDir, `worker-${basename(input.runId)}-${basename(input.runAttempt)}.json`),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    console.log(
      `[platinum-ci] exit=${exitCode} worker_ms=${workerDurationMs} total_ms=${metadata.totalDurationMs}`,
    );
    return exitCode;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}
