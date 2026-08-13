import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  DaytonaApi,
  type DaytonaCiInput,
  type DaytonaSandbox,
  createDaytonaSandbox,
  deleteSandbox as deleteDaytonaSandbox,
  downloadArtifacts as downloadDaytonaArtifacts,
  ensureWarmSnapshot,
  execute as executeDaytona,
  getSandboxByName,
  readRemoteExitCode,
  readRemoteLog,
  statRemoteLog,
  waitForSandbox as waitForDaytonaSandbox,
} from './daytona-ci';
import {
  PlatinumApi,
  type PlatinumSandbox,
  buildPlatinumTemplateSpec,
  downloadArtifacts as downloadPlatinumArtifacts,
  ensureTemplate,
  ensureWarmTemplate,
  exec as execPlatinum,
  observePlatinumSandboxStart,
  observePlatinumWorker,
  platinumWarmReadinessTimeoutMs,
  stat as statPlatinum,
  waitForWarmSandbox,
} from './platinum-ci';
import {
  PreviewInfrastructureError,
  type SandboxPreviewResult,
  buildPreviewBootstrapScript,
  previewLockfileHash,
  previewSandboxName,
  selectStalePreviewSandboxIds,
} from './sandbox-preview';
import type { PreviewRuntimeSecrets } from './preview-stack';

const PREVIEW_TIMEOUT_MS = 90 * 60_000;
const LOG_CHUNK_BYTES = 1024 * 1024;

export interface SandboxPreviewDeploymentInput {
  repository: string;
  ref: string;
  sha: string;
  prNumber: number;
  runId: string;
  runAttempt: string;
  root: string;
  lockfileHash: string;
  secrets: PreviewRuntimeSecrets;
  platinum: { apiUrl: string; apiKey: string };
  daytona: { apiUrl: string; apiKey: string; target: string };
}

interface PlatinumSandboxPage {
  rows?: PlatinumSandbox[];
  has_more?: boolean;
}

interface PreviewLink {
  url?: string;
  token?: string;
}

function encodedFileCommand(path: string, content: string, mode = '0600'): string {
  if (!/^\/[a-z0-9_./-]+$/i.test(path)) throw new Error(`invalid remote path: ${path}`);
  return `mkdir -p "$(dirname ${path})" && printf %s ${Buffer.from(content).toString('base64')} | base64 -d > ${path} && chmod ${mode} ${path}`;
}

function validatedPreviewUrl(value: string | undefined): string {
  if (!value) throw new Error('sandbox provider did not return a preview URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`sandbox preview URL must use credential-free HTTPS: ${url.origin}`);
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.origin;
}

async function writeDeploymentResult(
  root: string,
  result: SandboxPreviewResult,
  input: SandboxPreviewDeploymentInput,
): Promise<void> {
  const directory = resolve(root, 'tests/test-results/preview');
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'deployment.json'),
    `${JSON.stringify(
      {
        ...result,
        repository: input.repository,
        prNumber: input.prNumber,
        gitSha: input.sha,
        reportUrl: result.previewUrl ? `${result.previewUrl}/_tests/` : null,
      },
      null,
      2,
    )}\n`,
  );
}

async function allPlatinumPreviewSandboxes(api: PlatinumApi): Promise<PlatinumSandbox[]> {
  const sandboxes: PlatinumSandbox[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await api.json<PlatinumSandboxPage>(
      `/v1/sandboxes?paginated=true&limit=${limit}&offset=${offset}`,
    );
    sandboxes.push(...(page.rows ?? []));
    if (!page.has_more || (page.rows ?? []).length === 0) return sandboxes;
  }
}

async function deletePlatinum(api: PlatinumApi, sandboxId: string): Promise<void> {
  try {
    await api.json(`/v1/sandboxes/${sandboxId}`, { method: 'DELETE' });
  } catch (error) {
    if (!String(error).includes('-> 404:')) throw error;
  }
}

async function replaceExistingPlatinumPreview(
  api: PlatinumApi,
  prNumber: number,
): Promise<void> {
  const name = previewSandboxName(prNumber);
  const existing = (await allPlatinumPreviewSandboxes(api)).filter(
    (sandbox) =>
      sandbox.name === name &&
      sandbox.metadata?.owner === 'kortix-preview' &&
      Number(sandbox.metadata?.pr_number) === prNumber,
  );
  for (const sandbox of existing) await deletePlatinum(api, sandbox.id);
}

export function platinumPreviewIdempotencyKey(input: {
  prNumber: number;
  sha: string;
  runId: string;
}): string {
  return `kortix-preview-${input.prNumber}-${input.sha}-${input.runId}`;
}

export async function deployPlatinumPreview(
  input: SandboxPreviewDeploymentInput,
): Promise<SandboxPreviewResult> {
  if (!input.platinum.apiKey) throw new PreviewInfrastructureError('PLATINUM_API_KEY is required');
  const api = new PlatinumApi(input.platinum.apiUrl, input.platinum.apiKey);
  let sandboxId = '';
  let launched = false;
  try {
    await replaceExistingPlatinumPreview(api, input.prNumber);
    const hash = previewLockfileHash(input.lockfileHash);
    const base = await ensureTemplate(
      api,
      buildPlatinumTemplateSpec({
        lockHash: hash,
        repository: input.repository,
        cacheSha: input.sha,
      }),
    );
    const template = await ensureWarmTemplate(api, base, hash);
    const startedAt = Date.now();
    const created = await api.json<PlatinumSandbox>(
      '/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000',
      {
        method: 'POST',
        headers: { 'idempotency-key': platinumPreviewIdempotencyKey(input) },
        body: JSON.stringify({
          name: previewSandboxName(input.prNumber),
          template: template.id,
          type: 'persistent',
          auto_stop_minutes: 0,
          auto_archive_days: 7,
          auto_delete_days: 7,
          cpu: 8,
          ram_mb: 16_384,
          disk_gb: 50,
          expose: [{ port: 8080, public: true }],
          metadata: {
            owner: 'kortix-preview',
            repository: input.repository,
            pr_number: String(input.prNumber),
            git_sha: input.sha,
            run_id: input.runId,
          },
        }),
      },
    );
    sandboxId = created.id;
    const sandbox = await observePlatinumSandboxStart({
      sandbox: created,
      startedAt,
      readSandbox: () => api.json<PlatinumSandbox>(`/v1/sandboxes/${created.id}`),
    });
    await waitForWarmSandbox(api, sandboxId, platinumWarmReadinessTimeoutMs(sandbox.via));
    let previewUrl = sandbox.exposed?.find((item) => item.port === 8080)?.url;
    if (!previewUrl) {
      const exposed = await api.json<{ url: string }>(`/v1/sandboxes/${sandboxId}/expose`, {
        method: 'POST',
        body: JSON.stringify({ port: 8080, public: true }),
      });
      previewUrl = exposed.url;
    }
    const origin = validatedPreviewUrl(previewUrl);
    await execPlatinum(api, sandboxId, ['bash', '-lc', 'mkdir -p /workspace/kortix-preview']);
    await api.write(
      `${sandboxId}:/workspace/kortix-preview/runtime-secrets.json`,
      `${JSON.stringify(input.secrets)}\n`,
      '0600',
    );
    await api.write(
      `${sandboxId}:/workspace/run-kortix-preview.sh`,
      buildPreviewBootstrapScript({ ...input, origin }),
      '0755',
    );
    const launch = await execPlatinum(api, sandboxId, [
      'bash',
      '-lc',
      'setsid -f /workspace/run-kortix-preview.sh >/workspace/kortix-preview/bootstrap.log 2>&1 </dev/null',
    ]);
    if ((launch.exit_code ?? 0) !== 0) {
      throw new Error(`Platinum preview launch failed: ${launch.stderr ?? ''}`);
    }
    launched = true;
    const exitCode = await observePlatinumWorker({
      startedAt: Date.now(),
      timeoutMs: PREVIEW_TIMEOUT_MS,
      checkExitCode: async () => {
        const status = await statPlatinum(api, sandboxId, '/workspace/kortix-preview/kortix-preview.exit', 1);
        if (!status) return null;
        const bytes = await api.read(
          sandboxId,
          '/workspace/kortix-preview/kortix-preview.exit',
          undefined,
          undefined,
          1,
        );
        const value = Number(new TextDecoder().decode(bytes).trim());
        if (!Number.isInteger(value)) throw new Error('Platinum preview wrote an invalid exit code');
        return value;
      },
      statLog: () => statPlatinum(api, sandboxId, '/workspace/kortix-preview/kortix-preview.log', 1),
      readLog: (offset, limit) =>
        api.read(
          sandboxId,
          '/workspace/kortix-preview/kortix-preview.log',
          offset,
          Math.min(limit, LOG_CHUNK_BYTES),
          1,
        ),
    });
    const result: SandboxPreviewResult = {
      provider: 'platinum',
      exitCode,
      sandboxId,
      previewUrl: origin,
    };
    await downloadPlatinumArtifacts(api, sandboxId, input.root).catch((error) => {
      console.warn(`[sandbox-preview] Platinum result download failed: ${String(error)}`);
    });
    await writeDeploymentResult(input.root, result, input);
    return result;
  } catch (error) {
    if (launched) throw error;
    if (sandboxId) await deletePlatinum(api, sandboxId).catch(() => {});
    throw new PreviewInfrastructureError('Platinum preview infrastructure failed', error);
  }
}

async function replaceExistingDaytonaPreview(
  api: DaytonaApi,
  prNumber: number,
): Promise<void> {
  const existing = await getSandboxByName(api, previewSandboxName(prNumber));
  if (!existing) return;
  if (
    existing.labels?.['kortix-preview'] !== 'true' ||
    existing.labels?.['kortix-preview-pr'] !== String(prNumber)
  ) {
    throw new Error(`refused to replace unowned Daytona sandbox ${existing.id}`);
  }
  await deleteDaytonaSandbox(api, existing.id);
}

export async function deployDaytonaPreview(
  input: SandboxPreviewDeploymentInput,
): Promise<SandboxPreviewResult> {
  if (!input.daytona.apiKey) throw new PreviewInfrastructureError('DAYTONA_API_KEY is required');
  const api = new DaytonaApi(input.daytona.apiUrl, input.daytona.apiKey);
  let sandbox: DaytonaSandbox | null = null;
  let launched = false;
  try {
    await replaceExistingDaytonaPreview(api, input.prNumber);
    const hash = previewLockfileHash(input.lockfileHash);
    const ciInput: DaytonaCiInput = {
      apiUrl: input.daytona.apiUrl,
      apiKey: input.daytona.apiKey,
      target: input.daytona.target,
      repository: input.repository,
      sha: input.sha,
      ref: input.ref,
      runId: input.runId,
      runAttempt: input.runAttempt,
      testArgs: [],
      root: input.root,
    };
    const snapshot = await ensureWarmSnapshot(api, ciInput, hash);
    sandbox = await waitForDaytonaSandbox(
      api,
      await createDaytonaSandbox(api, {
        name: previewSandboxName(input.prNumber),
        snapshot: snapshot.name,
        target: input.daytona.target,
        public: true,
        autoStopInterval: 0,
        autoArchiveInterval: 10_080,
        autoDeleteInterval: 10_080,
        labels: {
          'kortix-preview': 'true',
          'kortix-preview-pr': String(input.prNumber),
          'kortix-preview-repository': input.repository,
          'kortix-preview-git-sha': input.sha,
          'kortix-preview-run-id': input.runId,
        },
      }),
    );
    const marker = await executeDaytona(
      api,
      sandbox,
      'test -s /workspace/.kortix-ci-warm-ready && ! pgrep -x dockerd >/dev/null && ! pgrep -x containerd >/dev/null',
      30,
    );
    if (marker.exitCode !== 0) throw new Error('Daytona preview did not restore the warm marker');
    const link = await api.json<PreviewLink>(
      `/sandbox/${encodeURIComponent(sandbox.id)}/ports/8080/preview-url`,
    );
    const origin = validatedPreviewUrl(link.url);
    const secretsUpload = await executeDaytona(
      api,
      sandbox,
      encodedFileCommand(
        '/workspace/kortix-preview/runtime-secrets.json',
        `${JSON.stringify(input.secrets)}\n`,
      ),
      60,
    );
    if (secretsUpload.exitCode !== 0) throw new Error(`Daytona secret upload failed: ${secretsUpload.result}`);
    const scriptUpload = await executeDaytona(
      api,
      sandbox,
      encodedFileCommand(
        '/workspace/run-kortix-preview.sh',
        buildPreviewBootstrapScript({ ...input, origin }),
        '0755',
      ),
      60,
    );
    if (scriptUpload.exitCode !== 0) throw new Error(`Daytona script upload failed: ${scriptUpload.result}`);
    const launch = await executeDaytona(
      api,
      sandbox,
      'setsid -f /workspace/run-kortix-preview.sh >/workspace/kortix-preview/bootstrap.log 2>&1 </dev/null',
      30,
    );
    if (launch.exitCode !== 0) throw new Error(`Daytona preview launch failed: ${launch.result}`);
    launched = true;
    const exitCode = await observePlatinumWorker({
      startedAt: Date.now(),
      timeoutMs: PREVIEW_TIMEOUT_MS,
      checkExitCode: () =>
        readRemoteExitCode(
          api,
          sandbox!,
          '/workspace/kortix-preview/kortix-preview.exit',
          'preview',
        ),
      statLog: () =>
        statRemoteLog(api, sandbox!, '/workspace/kortix-preview/kortix-preview.log', 'preview'),
      readLog: (offset, limit) =>
        readRemoteLog(
          api,
          sandbox!,
          '/workspace/kortix-preview/kortix-preview.log',
          offset,
          Math.min(limit, LOG_CHUNK_BYTES),
          'preview',
        ),
    });
    const result: SandboxPreviewResult = {
      provider: 'daytona',
      exitCode,
      sandboxId: sandbox.id,
      previewUrl: origin,
    };
    await downloadDaytonaArtifacts(api, sandbox, input.root).catch((error) => {
      console.warn(`[sandbox-preview] Daytona result download failed: ${String(error)}`);
    });
    await writeDeploymentResult(input.root, result, input);
    return result;
  } catch (error) {
    if (launched) throw error;
    if (sandbox) await deleteDaytonaSandbox(api, sandbox.id).catch(() => {});
    throw new PreviewInfrastructureError('Daytona preview infrastructure failed', error);
  }
}

export async function teardownPlatinumPreview(input: {
  apiUrl: string;
  apiKey: string;
  prNumber: number;
}): Promise<number> {
  if (!input.apiKey) return 0;
  const api = new PlatinumApi(input.apiUrl, input.apiKey);
  const name = previewSandboxName(input.prNumber);
  const owned = (await allPlatinumPreviewSandboxes(api)).filter(
    (sandbox) =>
      sandbox.name === name &&
      sandbox.metadata?.owner === 'kortix-preview' &&
      Number(sandbox.metadata?.pr_number) === input.prNumber,
  );
  for (const sandbox of owned) await deletePlatinum(api, sandbox.id);
  return owned.length;
}

export async function teardownDaytonaPreview(input: {
  apiUrl: string;
  apiKey: string;
  prNumber: number;
}): Promise<number> {
  if (!input.apiKey) return 0;
  const api = new DaytonaApi(input.apiUrl, input.apiKey);
  const sandbox = await getSandboxByName(api, previewSandboxName(input.prNumber));
  if (!sandbox) return 0;
  if (
    sandbox.labels?.['kortix-preview'] !== 'true' ||
    sandbox.labels?.['kortix-preview-pr'] !== String(input.prNumber)
  ) {
    throw new Error(`refused to delete unowned Daytona sandbox ${sandbox.id}`);
  }
  await deleteDaytonaSandbox(api, sandbox.id);
  return 1;
}

export async function reconcilePlatinumPreviews(input: {
  apiUrl: string;
  apiKey: string;
  activePullRequests: ReadonlyMap<number, string>;
}): Promise<number> {
  if (!input.apiKey) return 0;
  const api = new PlatinumApi(input.apiUrl, input.apiKey);
  const sandboxes = await allPlatinumPreviewSandboxes(api);
  const stale = selectStalePreviewSandboxIds(sandboxes, input.activePullRequests);
  for (const sandboxId of stale) await deletePlatinum(api, sandboxId);
  return stale.length;
}

interface DaytonaSandboxPage {
  items?: DaytonaSandbox[];
  nextCursor?: string | null;
}

export function daytonaPreviewLabelsFilter(): string {
  return JSON.stringify({ 'kortix-preview': 'true' });
}

async function allDaytonaPreviewSandboxes(api: DaytonaApi): Promise<DaytonaSandbox[]> {
  const sandboxes: DaytonaSandbox[] = [];
  let cursor = '';
  do {
    const query = new URLSearchParams({
      limit: '100',
      labels: daytonaPreviewLabelsFilter(),
    });
    if (cursor) query.set('cursor', cursor);
    const page = await api.json<DaytonaSandboxPage>(`/sandbox?${query}`);
    sandboxes.push(...(page.items ?? []));
    cursor = page.nextCursor ?? '';
  } while (cursor);
  return sandboxes;
}

export async function reconcileDaytonaPreviews(input: {
  apiUrl: string;
  apiKey: string;
  activePullRequests: ReadonlyMap<number, string>;
}): Promise<number> {
  if (!input.apiKey) return 0;
  const api = new DaytonaApi(input.apiUrl, input.apiKey);
  const sandboxes = await allDaytonaPreviewSandboxes(api);
  const records = sandboxes.map((sandbox) => ({
    id: sandbox.id,
    metadata: {
      owner: sandbox.labels?.['kortix-preview'] === 'true' ? 'kortix-preview' : '',
      pr_number: sandbox.labels?.['kortix-preview-pr'],
      git_sha: sandbox.labels?.['kortix-preview-git-sha'],
    },
  }));
  const stale = selectStalePreviewSandboxIds(records, input.activePullRequests);
  for (const sandboxId of stale) await deleteDaytonaSandbox(api, sandboxId);
  return stale.length;
}
