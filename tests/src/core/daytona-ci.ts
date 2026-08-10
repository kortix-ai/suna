import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PLATINUM_CI_BUN_VERSION,
  PLATINUM_CI_NODE_IMAGE,
  PLATINUM_CI_PNPM_VERSION,
  buildWorkerScript,
  observePlatinumWorker,
  providerMetadataIdentifier,
} from './platinum-ci';

export const DAYTONA_CI_SNAPSHOT_VERSION = 'v3';
const DAYTONA_CI_BASE_SNAPSHOT_VERSION = 'v2';

const POLL_MS = 3_000;
const SNAPSHOT_TIMEOUT_MS = 45 * 60_000;
const SANDBOX_TIMEOUT_MS = 15 * 60_000;
const WORKER_TIMEOUT_MS = 3 * 60 * 60_000;
const LOG_CHUNK_BYTES = 1024 * 1024;
const API_ATTEMPTS = 6;
const DAYTONA_CI_CPU = 6;
const DAYTONA_CI_MEMORY_GB = 12;
const DAYTONA_CI_DISK_GB = 40;
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 524]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface DaytonaCiInput {
  apiUrl: string;
  apiKey: string;
  target: string;
  repository: string;
  sha: string;
  ref: string;
  runId: string;
  runAttempt: string;
  testArgs: string[];
  root: string;
}

export interface DaytonaSnapshot {
  id: string;
  name: string;
  state?: string;
  errorReason?: string;
}

export interface DaytonaSandbox {
  id: string;
  name: string;
  state?: string;
  errorReason?: string;
  toolboxProxyUrl?: string;
  labels?: Record<string, string>;
}

interface DaytonaSnapshotPage {
  items?: DaytonaSnapshot[];
  total?: number;
  totalPages?: number;
}

interface DaytonaExecuteResponse {
  exitCode?: number;
  code?: number;
  result?: string;
}

export class DaytonaHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DaytonaHttpError';
  }
}

export function validateDaytonaCiInput(input: DaytonaCiInput): void {
  if (!input.apiKey) throw new Error('DAYTONA_API_KEY is required');
  if (!/^https:\/\//.test(input.apiUrl)) throw new Error('DAYTONA_API_URL must use https');
  if (!/^[a-z0-9_.-]+$/i.test(input.target))
    throw new Error(`invalid Daytona target: ${input.target}`);
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

export async function daytonaLockfileHash(root: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(resolve(root, 'pnpm-lock.yaml')))
    .digest('hex');
}

export function daytonaSnapshotName(lockHash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(lockHash)) throw new Error(`invalid lockfile hash: ${lockHash}`);
  return `kortix-ci-daytona-${DAYTONA_CI_SNAPSHOT_VERSION}-${lockHash.slice(0, 16)}`;
}

export function daytonaBaseSnapshotName(lockHash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(lockHash)) throw new Error(`invalid lockfile hash: ${lockHash}`);
  return `kortix-ci-daytona-${DAYTONA_CI_BASE_SNAPSHOT_VERSION}-${lockHash.slice(0, 16)}-base`;
}

export function daytonaWorkerName(runId: string, runAttempt: string): string {
  return `kortix-ci-${runId}-${runAttempt}`.slice(0, 64);
}

export function buildDaytonaBaseDockerfile(input: {
  repository: string;
  cacheSha: string;
}): string {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(input.repository)) {
    throw new Error(`invalid GitHub repository: ${input.repository}`);
  }
  if (!/^[a-f0-9]{40}$/i.test(input.cacheSha))
    throw new Error(`invalid Git SHA: ${input.cacheSha}`);
  return `FROM ${PLATINUM_CI_NODE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN set -eux; apt-get update; apt-get install -y --no-install-recommends ca-certificates curl docker.io git iptables jq kmod postgresql-client procps ripgrep unzip xz-utils; rm -rf /var/lib/apt/lists/*
RUN npm install --global bun@${PLATINUM_CI_BUN_VERSION} && corepack prepare pnpm@${PLATINUM_CI_PNPM_VERSION} --activate
RUN set -eux; mkdir -p /workspace /root/.cache/ms-playwright; git init /workspace/suna; git -C /workspace/suna remote add origin https://github.com/${input.repository}.git; git -C /workspace/suna fetch --depth=1 origin ${input.cacheSha}; git -C /workspace/suna checkout --detach FETCH_HEAD; test "$(git -C /workspace/suna rev-parse HEAD)" = "${input.cacheSha}"
RUN set -eux; cd /workspace/suna; corepack enable; pnpm install --frozen-lockfile; pnpm --dir tests exec playwright install --with-deps chromium; rm -rf /workspace/suna/tests/test-results
WORKDIR /workspace/suna
ENTRYPOINT ["sleep", "infinity"]
`;
}

export function buildDaytonaWorkerRequest(input: {
  snapshot: string;
  target: string;
  repository: string;
  sha: string;
  runId: string;
  runAttempt: string;
}): Record<string, unknown> {
  return {
    name: daytonaWorkerName(input.runId, input.runAttempt),
    snapshot: input.snapshot,
    target: input.target,
    public: false,
    autoStopInterval: 15,
    autoArchiveInterval: 1_440,
    autoDeleteInterval: 1_440,
    labels: {
      'kortix-ci': 'true',
      'kortix-ci-run-id': input.runId,
      'kortix-ci-run-attempt': input.runAttempt,
      'kortix-ci-repository': input.repository,
      'kortix-ci-git-sha': input.sha,
    },
  };
}

export function buildDaytonaWarmBuilderRequest(input: {
  snapshot: string;
  target: string;
  repository: string;
  sha: string;
  runId: string;
  runAttempt: string;
  builderName: string;
}): Record<string, unknown> & { name: string; labels: Record<string, string> } {
  const request = buildDaytonaWorkerRequest({
    snapshot: input.snapshot,
    target: input.target,
    repository: input.repository,
    sha: input.sha,
    runId: input.runId,
    runAttempt: input.runAttempt,
  });
  return {
    ...request,
    name: input.builderName,
    labels: request.labels as Record<string, string>,
  };
}

export function isExactDaytonaWarmBuilder(
  sandbox: { name: string; labels?: Record<string, string> },
  input: { runId: string; runAttempt: string; builderName: string },
): boolean {
  return (
    sandbox.name === input.builderName &&
    sandbox.labels?.['kortix-ci'] === 'true' &&
    sandbox.labels?.['kortix-ci-run-id'] === input.runId &&
    sandbox.labels?.['kortix-ci-run-attempt'] === input.runAttempt
  );
}

export function isRetryableDaytonaError(error: unknown): boolean {
  if (error instanceof DaytonaHttpError) return TRANSIENT_STATUS_CODES.has(error.status);
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /abort|connection reset|econnreset|fetch failed|network|socket|timed?\s*out/i.test(
    message,
  );
}

export async function retryDaytonaOperation<T>(input: {
  label: string;
  operation: () => Promise<T>;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const attempts = input.attempts ?? API_ATTEMPTS;
  const wait = input.sleep ?? sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableDaytonaError(error)) throw error;
      const delayMs = Math.min(15_000, 1_000 * 2 ** (attempt - 1));
      console.warn(
        `[daytona-ci] retry label=${input.label} attempt=${attempt + 1}/${attempts} delay_ms=${delayMs} error=${String(error)}`,
      );
      await wait(delayMs);
    }
  }
  throw lastError;
}

export class DaytonaApi {
  readonly base: string;
  readonly headers: Record<string, string>;

  constructor(apiUrl: string, apiKey: string) {
    this.base = apiUrl.replace(/\/+$/, '');
    this.headers = { authorization: `Bearer ${apiKey}` };
  }

  async json<T>(
    path: string,
    init: RequestInit = {},
    options: { retry?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const method = String(init.method ?? 'GET').toUpperCase();
    const url = /^https:\/\//.test(path) ? path : `${this.base}${path}`;
    const operation = async () => {
      const response = await fetch(url, {
        ...init,
        headers: {
          ...this.headers,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new DaytonaHttpError(
          `Daytona ${method} ${path} -> ${response.status}: ${body}`,
          response.status,
        );
      }
      return (body ? JSON.parse(body) : null) as T;
    };
    return options.retry === false
      ? operation()
      : retryDaytonaOperation({ label: `${method} ${path}`, operation });
  }

  async bytes(url: string, attempts = API_ATTEMPTS): Promise<Uint8Array> {
    return retryDaytonaOperation({
      label: `GET ${new URL(url).pathname}`,
      attempts,
      operation: async () => {
        const response = await fetch(url, {
          headers: this.headers,
          signal: AbortSignal.timeout(5 * 60_000),
        });
        if (!response.ok) {
          throw new DaytonaHttpError(
            `Daytona file GET -> ${response.status}: ${await response.text()}`,
            response.status,
          );
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    });
  }
}

function snapshotState(snapshot: DaytonaSnapshot): string {
  return String(snapshot.state ?? '').toLowerCase();
}

async function findSnapshot(api: DaytonaApi, name: string): Promise<DaytonaSnapshot | null> {
  const page = await api.json<DaytonaSnapshotPage>(
    `/snapshots?name=${encodeURIComponent(name)}&limit=20&page=1`,
  );
  return (page.items ?? []).find((snapshot) => snapshot.name === name) ?? null;
}

async function waitForSnapshot(
  api: DaytonaApi,
  snapshot: DaytonaSnapshot,
): Promise<DaytonaSnapshot> {
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  let current = snapshot;
  let lastState = '';
  while (Date.now() < deadline) {
    const state = snapshotState(current);
    if (state !== lastState) {
      console.log(`[daytona-ci] snapshot=${current.name} state=${state}`);
      lastState = state;
    }
    if (state === 'active') return current;
    if (['error', 'build_failed', 'failed'].includes(state)) {
      throw new Error(
        `Daytona snapshot ${current.name} entered state=${state}: ${current.errorReason ?? ''}`,
      );
    }
    await sleep(POLL_MS);
    current = await api.json<DaytonaSnapshot>(
      `/snapshots/${encodeURIComponent(current.id || current.name)}`,
    );
  }
  throw new Error(
    `Daytona snapshot ${current.name} did not become active within ${SNAPSHOT_TIMEOUT_MS}ms`,
  );
}

async function ensureBaseSnapshot(
  api: DaytonaApi,
  input: DaytonaCiInput,
  lockHash: string,
): Promise<DaytonaSnapshot> {
  const name = daytonaBaseSnapshotName(lockHash);
  const existing = await findSnapshot(api, name);
  if (existing && !['error', 'build_failed', 'failed'].includes(snapshotState(existing))) {
    console.log(`[daytona-ci] snapshot=${name} cache=hit id=${existing.id}`);
    return waitForSnapshot(api, existing);
  }
  if (existing) {
    await api.json(`/snapshots/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
  }
  console.log(`[daytona-ci] snapshot=${name} cache=miss`);
  const created = await api.json<DaytonaSnapshot>(
    '/snapshots',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        buildInfo: {
          dockerfileContent: buildDaytonaBaseDockerfile({
            repository: input.repository,
            cacheSha: input.sha,
          }),
        },
        cpu: DAYTONA_CI_CPU,
        memory: DAYTONA_CI_MEMORY_GB,
        disk: DAYTONA_CI_DISK_GB,
        regionId: input.target,
      }),
    },
    { retry: false, timeoutMs: 5 * 60_000 },
  );
  return waitForSnapshot(api, created);
}

async function waitForSandbox(api: DaytonaApi, sandbox: DaytonaSandbox): Promise<DaytonaSandbox> {
  const deadline = Date.now() + SANDBOX_TIMEOUT_MS;
  let current = sandbox;
  let lastState = '';
  while (Date.now() < deadline) {
    const state = String(current.state ?? '').toLowerCase();
    if (state !== lastState) {
      console.log(`[daytona-ci] sandbox=${current.id} state=${state}`);
      lastState = state;
    }
    if (state === 'started') return current;
    if (['error', 'build_failed', 'destroyed', 'archived'].includes(state)) {
      throw new Error(
        `Daytona sandbox ${current.id} entered state=${state}: ${current.errorReason ?? ''}`,
      );
    }
    await sleep(POLL_MS);
    current = await api.json<DaytonaSandbox>(`/sandbox/${encodeURIComponent(current.id)}`);
  }
  throw new Error(
    `Daytona sandbox ${current.id} did not become started within ${SANDBOX_TIMEOUT_MS}ms`,
  );
}

async function getSandboxByName(api: DaytonaApi, name: string): Promise<DaytonaSandbox | null> {
  try {
    return await api.json<DaytonaSandbox>(
      `/sandbox/${encodeURIComponent(name)}`,
      {},
      { retry: false },
    );
  } catch (error) {
    if (error instanceof DaytonaHttpError && error.status === 404) return null;
    throw error;
  }
}

export async function createDaytonaSandbox(
  api: DaytonaApi,
  request: Record<string, unknown>,
): Promise<DaytonaSandbox> {
  const name = String(request.name ?? '');
  if (!name) throw new Error('Daytona sandbox request requires a name');
  let lastError: unknown;
  for (let createAttempt = 1; createAttempt <= 3; createAttempt += 1) {
    try {
      return await api.json<DaytonaSandbox>(
        '/sandbox',
        {
          method: 'POST',
          body: JSON.stringify(request),
        },
        { retry: false, timeoutMs: 5 * 60_000 },
      );
    } catch (error) {
      lastError = error;
      const conflict = error instanceof DaytonaHttpError && error.status === 409;
      if (!conflict && !isRetryableDaytonaError(error)) throw error;
      console.warn(
        `[daytona-ci] sandbox create response unavailable name=${name} attempt=${createAttempt}/3; reconciling`,
      );
    }
    for (let observation = 1; observation <= 10; observation += 1) {
      try {
        const existing = await getSandboxByName(api, name);
        if (existing) {
          console.log(`[daytona-ci] sandbox create reconciled name=${name} id=${existing.id}`);
          return existing;
        }
      } catch (error) {
        if (!isRetryableDaytonaError(error)) throw error;
      }
      await sleep(POLL_MS);
    }
  }
  throw lastError;
}

function toolboxBase(sandbox: DaytonaSandbox): string {
  if (!sandbox.toolboxProxyUrl)
    throw new Error(`Daytona sandbox ${sandbox.id} has no toolboxProxyUrl`);
  return `${sandbox.toolboxProxyUrl.replace(/\/+$/, '')}/${encodeURIComponent(sandbox.id)}`;
}

async function execute(
  api: DaytonaApi,
  sandbox: DaytonaSandbox,
  command: string,
  timeoutSeconds = 300,
): Promise<Required<Pick<DaytonaExecuteResponse, 'exitCode' | 'result'>>> {
  const response = await api.json<DaytonaExecuteResponse>(
    `${toolboxBase(sandbox)}/process/execute`,
    {
      method: 'POST',
      body: JSON.stringify({ command, timeout: timeoutSeconds }),
    },
    { timeoutMs: (timeoutSeconds + 30) * 1_000 },
  );
  return {
    exitCode: Number(response.exitCode ?? response.code ?? 1),
    result: String(response.result ?? ''),
  };
}

function base64Command(script: string, path: string): string {
  return `printf %s ${Buffer.from(script).toString('base64')} | base64 -d > ${path} && chmod 0755 ${path}`;
}

export function buildDaytonaWarmScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
STATUS=/workspace/daytona-warm.exit
rm -f "$STATUS"
finish() {
  local code="$1"
  set +e
  printf '%s\\n' "$code" > "$STATUS"
}
trap 'code=$?; finish "$code"' EXIT
exec > >(tee -a /workspace/daytona-warm.log) 2>&1
cd /workspace/suna
rm -f /workspace/.kortix-ci-warm-ready /var/run/docker.pid /var/run/docker.sock
for module in overlay bridge br_netfilter veth nf_tables ip_tables iptable_nat; do modprobe "$module"; done
dockerd --host=unix:///var/run/docker.sock >/workspace/daytona-dockerd.log 2>&1 &
timeout 180 sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'
docker info >/dev/null
pnpm exec supabase start --ignore-health-check
docker image ls -q | sort -u | wc -l > /workspace/.kortix-ci-warm-ready
grep -Eq '^[1-9][0-9]*$' /workspace/.kortix-ci-warm-ready
docker image ls --digests
pnpm exec supabase stop --no-backup
pkill -TERM -x dockerd
timeout 60 sh -c 'while pgrep -x dockerd >/dev/null || pgrep -x containerd >/dev/null; do sleep 1; done'
rm -f /var/run/docker.pid /var/run/docker.sock
rm -rf /var/lib/docker/tmp /var/lib/docker/runtimes
`;
}

async function deleteSandbox(api: DaytonaApi, idOrName: string): Promise<void> {
  try {
    await api.json(`/sandbox/${encodeURIComponent(idOrName)}`, { method: 'DELETE' });
  } catch (error) {
    if (!(error instanceof DaytonaHttpError && error.status === 404)) throw error;
  }
}

async function waitForWarmSnapshotOwner(
  api: DaytonaApi,
  snapshotName: string,
  builderName: string,
): Promise<DaytonaSnapshot | null> {
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  let lastBuilderState = '';
  while (Date.now() < deadline) {
    const snapshot = await findSnapshot(api, snapshotName);
    if (snapshot) {
      if (['error', 'build_failed', 'failed'].includes(snapshotState(snapshot))) {
        throw new Error(
          `Daytona warm snapshot ${snapshotName} entered state=${snapshotState(snapshot)}: ${snapshot.errorReason ?? ''}`,
        );
      }
      return waitForSnapshot(api, snapshot);
    }

    const builder = await getSandboxByName(api, builderName);
    if (!builder) return null;
    const state = String(builder.state ?? '').toLowerCase();
    if (state !== lastBuilderState) {
      console.log(
        `[daytona-ci] warm_builder=${builderName} owner=${builder.labels?.['kortix-ci-run-id'] ?? 'unknown'} state=${state}`,
      );
      lastBuilderState = state;
    }
    if (['error', 'build_failed', 'stopped', 'archived', 'destroyed'].includes(state)) return null;
    await sleep(POLL_MS);
  }
  throw new Error(
    `Daytona warm builder ${builderName} did not produce snapshot ${snapshotName} within ${SNAPSHOT_TIMEOUT_MS}ms`,
  );
}

async function ensureWarmSnapshot(
  api: DaytonaApi,
  input: DaytonaCiInput,
  lockHash: string,
): Promise<DaytonaSnapshot> {
  const name = daytonaSnapshotName(lockHash);
  const existing = await findSnapshot(api, name);
  if (existing && !['error', 'build_failed', 'failed'].includes(snapshotState(existing))) {
    console.log(`[daytona-ci] snapshot=${name} cache=hit id=${existing.id}`);
    return waitForSnapshot(api, existing);
  }
  if (existing) {
    await api.json(`/snapshots/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
  }

  const base = await ensureBaseSnapshot(api, input, lockHash);
  const builderName = `${name}-builder`.slice(0, 64);
  let builder: DaytonaSandbox | null = null;
  try {
    const snapshotAfterBase = await findSnapshot(api, name);
    if (snapshotAfterBase) return waitForSnapshot(api, snapshotAfterBase);

    const request = buildDaytonaWarmBuilderRequest({
      snapshot: base.name,
      target: input.target,
      repository: input.repository,
      sha: input.sha,
      runId: input.runId,
      runAttempt: input.runAttempt,
      builderName,
    });
    for (;;) {
      const existingBuilder = await getSandboxByName(api, builderName);
      if (
        existingBuilder &&
        !isExactDaytonaWarmBuilder(existingBuilder, {
          runId: input.runId,
          runAttempt: input.runAttempt,
          builderName,
        })
      ) {
        const ownedSnapshot = await waitForWarmSnapshotOwner(api, name, builderName);
        if (ownedSnapshot) return ownedSnapshot;
        try {
          await deleteSandbox(api, existingBuilder.id);
        } catch (error) {
          if (!(error instanceof DaytonaHttpError && error.status === 409)) throw error;
          console.warn(`[daytona-ci] warm_builder=${builderName} cleanup=busy`);
        }
        await sleep(POLL_MS);
        continue;
      }

      builder = existingBuilder ?? (await createDaytonaSandbox(api, request));
      if (
        isExactDaytonaWarmBuilder(builder, {
          runId: input.runId,
          runAttempt: input.runAttempt,
          builderName,
        })
      ) {
        builder = await waitForSandbox(api, builder);
        break;
      }

      const ownedSnapshot = await waitForWarmSnapshotOwner(api, name, builderName);
      builder = null;
      if (ownedSnapshot) return ownedSnapshot;
    }

    const warmScript = buildDaytonaWarmScript();
    const uploaded = await execute(
      api,
      builder,
      base64Command(warmScript, '/workspace/prepare-daytona-warm.sh'),
      60,
    );
    if (uploaded.exitCode !== 0)
      throw new Error(`Daytona warm script upload failed: ${uploaded.result}`);
    const launched = await execute(
      api,
      builder,
      'setsid -f /workspace/prepare-daytona-warm.sh >/workspace/daytona-warm-bootstrap.log 2>&1 </dev/null',
      30,
    );
    if (launched.exitCode !== 0)
      throw new Error(`Daytona warm script launch failed: ${launched.result}`);
    const prepareExitCode = await observePlatinumWorker({
      startedAt: Date.now(),
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      pollMs: POLL_MS,
      checkExitCode: () =>
        readRemoteExitCode(api, builder!, '/workspace/daytona-warm.exit', 'warm preparation'),
      statLog: () =>
        statRemoteLog(api, builder!, '/workspace/daytona-warm.log', 'warm preparation'),
      readLog: (offset, limit) =>
        readRemoteLog(
          api,
          builder!,
          '/workspace/daytona-warm.log',
          offset,
          Math.min(limit, LOG_CHUNK_BYTES),
          'warm preparation',
        ),
    });
    if (prepareExitCode !== 0)
      throw new Error(`Daytona warm preparation exited with code ${prepareExitCode}`);
    const marker = await execute(
      api,
      builder,
      'test -s /workspace/.kortix-ci-warm-ready && ! pgrep -x dockerd >/dev/null && ! pgrep -x containerd >/dev/null && test ! -S /var/run/docker.sock && cat /workspace/.kortix-ci-warm-ready',
      30,
    );
    if (marker.exitCode !== 0) throw new Error('Daytona warm snapshot marker is not valid');
    console.log(`[daytona-ci] warm_sandbox_ready=1 docker_images=${marker.result.trim()}`);

    await api.json(
      `/sandbox/${encodeURIComponent(builder.id)}/snapshot`,
      {
        method: 'POST',
        body: JSON.stringify({ name }),
      },
      { retry: false, timeoutMs: SNAPSHOT_TIMEOUT_MS },
    );

    const created = await findSnapshot(api, name);
    if (!created) throw new Error(`Daytona warm snapshot ${name} was not created`);
    return waitForSnapshot(api, created);
  } finally {
    if (builder) await deleteSandbox(api, builder.id).catch(() => {});
  }
}

async function readRemoteExitCode(
  api: DaytonaApi,
  sandbox: DaytonaSandbox,
  path: string,
  label: string,
): Promise<number | null> {
  const result = await execute(
    api,
    sandbox,
    `if [[ -f ${path} ]]; then cat ${path}; else exit 3; fi`,
    30,
  );
  if (result.exitCode === 3) return null;
  if (result.exitCode !== 0)
    throw new Error(`Daytona ${label} status check failed: ${result.result}`);
  const exitCode = Number(result.result.trim());
  if (!Number.isInteger(exitCode)) throw new Error(`Daytona ${label} wrote an invalid exit code`);
  return exitCode;
}

async function statRemoteLog(
  api: DaytonaApi,
  sandbox: DaytonaSandbox,
  path: string,
  label: string,
): Promise<{ size: number } | null> {
  const result = await execute(
    api,
    sandbox,
    `if [[ -f ${path} ]]; then stat -c %s ${path}; else exit 3; fi`,
    30,
  );
  if (result.exitCode === 3) return null;
  if (result.exitCode !== 0) throw new Error(`Daytona ${label} log stat failed: ${result.result}`);
  const size = Number(result.result.trim());
  if (!Number.isInteger(size) || size < 0)
    throw new Error(`Daytona ${label} log stat returned an invalid size`);
  return { size };
}

async function readRemoteLog(
  api: DaytonaApi,
  sandbox: DaytonaSandbox,
  path: string,
  offset: number,
  limit: number,
  label: string,
): Promise<Uint8Array> {
  const result = await execute(
    api,
    sandbox,
    `dd if=${path} bs=1 skip=${offset} count=${limit} status=none | base64 -w0`,
    60,
  );
  if (result.exitCode !== 0) throw new Error(`Daytona ${label} log read failed: ${result.result}`);
  return Uint8Array.from(Buffer.from(result.result.trim(), 'base64'));
}

async function downloadArtifacts(
  api: DaytonaApi,
  sandbox: DaytonaSandbox,
  root: string,
): Promise<void> {
  const url = `${toolboxBase(sandbox)}/files/download?path=${encodeURIComponent('/workspace/kortix-test-results.tar.gz')}`;
  const bytes = await api.bytes(url);
  const outputDir = resolve(root, 'tests/test-results');
  const archive = resolve(outputDir, 'daytona-worker.tar.gz');
  await mkdir(outputDir, { recursive: true });
  await writeFile(archive, bytes);
  const extracted = Bun.spawn(['tar', '-xzf', archive, '-C', root], {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await extracted.exited;
  if (code !== 0) throw new Error(`Daytona artifact extraction exited with code ${code}`);
}

export async function runDaytonaCi(input: DaytonaCiInput): Promise<number> {
  validateDaytonaCiInput(input);
  const totalStartedAt = Date.now();
  const api = new DaytonaApi(input.apiUrl, input.apiKey);
  const lockHash = await daytonaLockfileHash(input.root);
  const snapshotStartedAt = Date.now();
  const snapshot = await ensureWarmSnapshot(api, input, lockHash);
  const snapshotDurationMs = Date.now() - snapshotStartedAt;
  console.log(`[daytona-ci] snapshot=${snapshot.name} id=${snapshot.id}`);

  let sandbox: DaytonaSandbox | null = null;
  const cleanup = async () => {
    if (!sandbox) return;
    const id = sandbox.id;
    await deleteSandbox(api, id);
    console.log(`[daytona-ci] deleted sandbox=${id}`);
    sandbox = null;
  };
  const onSignal = (signal: string) => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const createStartedAt = Date.now();
  let workerStartedAt = 0;
  try {
    sandbox = await waitForSandbox(
      api,
      await createDaytonaSandbox(
        api,
        buildDaytonaWorkerRequest({
          snapshot: snapshot.name,
          target: input.target,
          repository: input.repository,
          sha: input.sha,
          runId: input.runId,
          runAttempt: input.runAttempt,
        }),
      ),
    );
    const sandboxCreateDurationMs = Date.now() - createStartedAt;

    const marker = await execute(
      api,
      sandbox,
      'test -s /workspace/.kortix-ci-warm-ready && ! pgrep -x dockerd >/dev/null && ! pgrep -x containerd >/dev/null && test ! -S /var/run/docker.sock && cat /workspace/.kortix-ci-warm-ready',
      30,
    );
    if (marker.exitCode !== 0) throw new Error('Daytona worker did not restore the warm marker');
    console.log(`[daytona-ci] warm_snapshot_restored=1 docker_images=${marker.result.trim()}`);

    const workerScript = buildWorkerScript({ ...input, provider: 'daytona' });
    const uploaded = await execute(
      api,
      sandbox,
      base64Command(workerScript, '/workspace/run-kortix-tests.sh'),
      60,
    );
    if (uploaded.exitCode !== 0)
      throw new Error(`Daytona worker script upload failed: ${uploaded.result}`);
    const launched = await execute(
      api,
      sandbox,
      'setsid -f /workspace/run-kortix-tests.sh >/workspace/daytona-bootstrap.log 2>&1 </dev/null',
      30,
    );
    if (launched.exitCode !== 0)
      throw new Error(`Daytona worker launch failed: ${launched.result}`);

    workerStartedAt = Date.now();
    const exitCode = await observePlatinumWorker({
      startedAt: workerStartedAt,
      timeoutMs: WORKER_TIMEOUT_MS,
      pollMs: POLL_MS,
      checkExitCode: () =>
        readRemoteExitCode(api, sandbox!, '/workspace/kortix-test.exit', 'worker'),
      statLog: () => statRemoteLog(api, sandbox!, '/workspace/kortix-test.log', 'worker'),
      readLog: (offset, limit) =>
        readRemoteLog(
          api,
          sandbox!,
          '/workspace/kortix-test.log',
          offset,
          Math.min(limit, LOG_CHUNK_BYTES),
          'worker',
        ),
    });
    const workerDurationMs = Date.now() - workerStartedAt;
    await downloadArtifacts(api, sandbox, input.root);
    await writeFile(
      resolve(input.root, 'tests/test-results/daytona-worker.json'),
      `${JSON.stringify(
        {
          provider: 'daytona',
          sandboxId: providerMetadataIdentifier(sandbox.id, 'Daytona sandbox ID'),
          snapshotId: providerMetadataIdentifier(snapshot.id, 'Daytona snapshot ID'),
          snapshotName: providerMetadataIdentifier(snapshot.name, 'Daytona snapshot name'),
          repository: input.repository,
          ref: input.ref,
          gitSha: input.sha,
          command: ['pnpm', 'test', ...(input.testArgs.length ? ['--', ...input.testArgs] : [])],
          snapshotDurationMs,
          sandboxCreateDurationMs,
          workerDurationMs,
          totalDurationMs: Date.now() - totalStartedAt,
          exitCode,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `[daytona-ci] exit=${exitCode} snapshot_ms=${snapshotDurationMs} sandbox_ms=${sandboxCreateDurationMs} worker_ms=${workerDurationMs} total_ms=${Date.now() - totalStartedAt}`,
    );
    return exitCode;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

export function isExactDaytonaCiSandbox(
  sandbox: DaytonaSandbox,
  runId: string,
  runAttempt: string,
): boolean {
  return (
    sandbox.name === daytonaWorkerName(runId, runAttempt) &&
    sandbox.labels?.['kortix-ci'] === 'true' &&
    sandbox.labels?.['kortix-ci-run-id'] === runId &&
    sandbox.labels?.['kortix-ci-run-attempt'] === runAttempt
  );
}

export async function cleanupDaytonaCiSandbox(input: {
  apiUrl: string;
  apiKey: string;
  runId: string;
  runAttempt: string;
}): Promise<number> {
  if (!input.apiKey || !input.runId) return 0;
  const api = new DaytonaApi(input.apiUrl, input.apiKey);
  const name = daytonaWorkerName(input.runId, input.runAttempt);
  let sandbox: DaytonaSandbox;
  try {
    sandbox = await api.json<DaytonaSandbox>(`/sandbox/${encodeURIComponent(name)}`);
  } catch (error) {
    if (error instanceof DaytonaHttpError && error.status === 404) {
      console.log('[daytona-ci] post_cleanup sandbox=none');
      return 0;
    }
    throw error;
  }
  if (!isExactDaytonaCiSandbox(sandbox, input.runId, input.runAttempt)) {
    console.warn(`[daytona-ci] post_cleanup refused sandbox=${sandbox.id} name=${sandbox.name}`);
    return 0;
  }
  await deleteSandbox(api, sandbox.id);
  console.log(`[daytona-ci] post_deleted sandbox=${sandbox.id}`);
  return 1;
}
