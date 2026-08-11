import { createSign } from 'node:crypto';

import type { PreviewRuntimeSecrets } from './preview-stack';

export type SandboxPreviewProvider = 'auto' | 'platinum' | 'daytona';

export interface SandboxPreviewInput {
  provider: SandboxPreviewProvider;
  prNumber: number;
  repository: string;
  sha: string;
}

export interface SandboxPreviewResult {
  provider: 'platinum' | 'daytona';
  exitCode: number;
  sandboxId?: string;
  previewUrl?: string;
}

interface GitHubAppIdentity {
  id?: number;
  slug?: string;
}

interface GitHubAppInstallation {
  id?: number;
  account?: { login?: string; type?: string };
  repository_selection?: string;
  permissions?: Record<string, string>;
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function previewGitHubAppJwt(appId: string, privateKey: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey.replaceAll('\\n', '\n')).toString('base64url')}`;
}

async function previewGitHubJson<T>(
  path: string,
  jwt: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'user-agent': 'kortix-preview-controller',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`preview GitHub App preflight ${path} returned ${response.status}: ${detail}`);
  }
  return response.json() as Promise<T>;
}

export async function assertPreviewManagedGitInstallation(input: {
  secrets: PreviewRuntimeSecrets;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<{ appId: number; slug: string; installationId: number; owner: string }> {
  const appId = input.secrets.KORTIX_GITHUB_APP_ID?.trim() ?? '';
  const privateKey = input.secrets.KORTIX_GITHUB_APP_PRIVATE_KEY?.trim() ?? '';
  const expectedSlug = input.secrets.KORTIX_GITHUB_APP_SLUG?.trim() ?? '';
  const expectedInstallationId = input.secrets.MANAGED_GIT_GITHUB_INSTALL_ID?.trim() ?? '';
  const expectedOwner = input.secrets.MANAGED_GIT_GITHUB_OWNER?.trim() ?? '';
  if (!appId || !privateKey || !expectedSlug || !expectedInstallationId || !expectedOwner) {
    throw new Error('preview GitHub App preflight requires all five managed Git secrets');
  }
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(expectedInstallationId)) {
    throw new Error('preview GitHub App and installation IDs must be decimal integers');
  }

  const jwt = previewGitHubAppJwt(appId, privateKey, input.nowMs ?? Date.now());
  const fetchImpl = input.fetchImpl ?? fetch;
  const [app, installations] = await Promise.all([
    previewGitHubJson<GitHubAppIdentity>('/app', jwt, fetchImpl),
    previewGitHubJson<GitHubAppInstallation[]>('/app/installations?per_page=100', jwt, fetchImpl),
  ]);
  if (String(app.id ?? '') !== appId || app.slug !== expectedSlug) {
    throw new Error(
      `preview GitHub App identity mismatch: expected ${appId}/${expectedSlug}; received ${app.id ?? 'missing'}/${app.slug ?? 'missing'}`,
    );
  }
  if (installations.length !== 1) {
    throw new Error(
      `preview GitHub App must have exactly one installation; received ${installations.length}`,
    );
  }
  const installation = installations[0]!;
  const actualOwner = installation.account?.login ?? '';
  if (
    String(installation.id ?? '') !== expectedInstallationId ||
    actualOwner.toLowerCase() !== expectedOwner.toLowerCase() ||
    installation.account?.type !== 'Organization'
  ) {
    throw new Error(
      `preview GitHub App installation mismatch: expected ${expectedInstallationId}/${expectedOwner}/Organization; ` +
      `received ${installation.id ?? 'missing'}/${actualOwner || 'missing'}/${installation.account?.type ?? 'missing'}`,
    );
  }
  if (installation.repository_selection !== 'all') {
    throw new Error(
      `preview GitHub App repository access must include all repositories; ` +
        `received ${installation.repository_selection ?? 'missing'}`,
    );
  }
  const administration = installation.permissions?.administration;
  const contents = installation.permissions?.contents;
  if (administration !== 'write' || contents !== 'write') {
    throw new Error(
      `preview GitHub App permissions must be administration:write and contents:write; ` +
        `received administration:${administration ?? 'missing'} contents:${contents ?? 'missing'}`,
    );
  }
  return {
    appId: Number(appId),
    slug: expectedSlug,
    installationId: Number(expectedInstallationId),
    owner: expectedOwner,
  };
}

export function previewLockfileHash(value: string): string {
  const hash = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('preview lockfile hash must contain 64 hex characters');
  }
  return hash;
}

export interface PreviewSandboxRecord {
  id: string;
  metadata?: Record<string, unknown>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildPreviewBootstrapScript(input: {
  provider: 'platinum' | 'daytona';
  repository: string;
  ref: string;
  sha: string;
  prNumber: number;
  origin: string;
}): string {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(input.repository)) {
    throw new Error(`invalid GitHub repository: ${input.repository}`);
  }
  if (!/^[a-z0-9_./-]+$/i.test(input.ref)) throw new Error(`invalid Git ref: ${input.ref}`);
  if (!/^[a-f0-9]{40}$/i.test(input.sha)) throw new Error(`invalid Git SHA: ${input.sha}`);
  previewSandboxName(input.prNumber);
  const origin = new URL(input.origin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/') {
    throw new Error('preview origin must be an HTTPS origin');
  }
  const instance = `pr-${input.prNumber}`;
  const state = '/workspace/kortix-preview';
  const instanceDir = `${state}/self-host/${instance}`;
  const compose = `docker compose --project-name kortix-${instance} --env-file ${instanceDir}/.env -f ${instanceDir}/docker-compose.yml -f ${state}/docker-compose.preview.yml`;
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace/suna
STATE=${state}
LOG="$STATE/kortix-preview.log"
STATUS="$STATE/kortix-preview.exit"
PHASE="$STATE/kortix-preview.phase"
SECRETS="$STATE/runtime-secrets.json"
export HOME=/root
export CI=1
export KORTIX_SELF_HOST_CONFIG_DIR="$STATE/self-host"

mkdir -p "$STATE" "$ROOT/tests/test-results"
rm -f "$STATUS" "$PHASE"
exec > >(tee -a "$LOG") 2>&1

finish() {
  local code="$1"
  set +e
  tar -czf /workspace/kortix-test-results.tar.gz -C "$ROOT" tests/test-results
  printf '%s\n' "$code" > "$STATUS"
}
trap 'code=$?; finish "$code"' EXIT

printf 'checkout\n' > "$PHASE"
test -d "$ROOT/.git"
git -C "$ROOT" remote set-url origin ${shellQuote(`https://github.com/${input.repository}.git`)}
git -C "$ROOT" fetch --depth=1 origin ${shellQuote(input.ref)}
git -C "$ROOT" checkout --detach --force FETCH_HEAD
git -C "$ROOT" clean -ffd
actual_sha="$(git -C "$ROOT" rev-parse HEAD)"
test "$actual_sha" = "${input.sha}"

cd "$ROOT"
corepack enable
pnpm install --offline --frozen-lockfile

printf 'docker\n' > "$PHASE"
for module in overlay bridge br_netfilter veth nf_tables ip_tables iptable_nat; do
  modprobe "$module" || true
done
if ! docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.pid /var/run/docker.sock
  nohup dockerd --host=unix:///var/run/docker.sock ${input.provider === 'daytona' ? '--storage-driver=fuse-overlayfs' : ''} > "$STATE/dockerd.log" 2>&1 &
  timeout 180 sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'
fi
docker info >/dev/null

printf 'configure\n' > "$PHASE"
bun apps/cli/src/index.ts self-host init --yes --local-images --no-restrict-account-creation --instance ${instance}
PREVIEW_INSTANCE_DIR=${shellQuote(instanceDir)} \
PREVIEW_STATE_DIR=${shellQuote(state)} \
PREVIEW_ORIGIN=${shellQuote(origin.origin)} \
PREVIEW_SHA=${shellQuote(input.sha)} \
PREVIEW_SECRETS_FILE="$SECRETS" \
bun tests/bin/preview-stack.ts

printf 'stack\n' > "$PHASE"
${compose} pull --policy always frontend kortix-api llm-gateway preview-edge mailpit
for stack_attempt in 1 2; do
  if ${compose} up -d --wait --wait-timeout 300; then
    break
  fi
  test "$stack_attempt" -lt 2
  printf 'stack readiness failed on attempt %s; retrying once after container restarts\n' "$stack_attempt"
  sleep 10
done

for _ in $(seq 1 60); do
  health="$(curl -fsS --max-time 5 ${shellQuote(`${origin.origin}/v1/health`)} 2>/dev/null || true)"
  if printf '%s' "$health" | jq -e --arg sha ${shellQuote(input.sha)} '.status == "ok" and .environment == "preview" and .commit == $sha' >/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 10 ${shellQuote(`${origin.origin}/v1/health`)} | jq -e --arg sha ${shellQuote(input.sha)} '.status == "ok" and .environment == "preview" and .commit == $sha' >/dev/null

printf 'tests\n' > "$PHASE"
set -a
source ${shellQuote(`${instanceDir}/.env.test`)}
set +a
pnpm test -- --target-full

printf 'ready\n' > "$PHASE"
`;
}

export class PreviewInfrastructureError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PreviewInfrastructureError';
  }
}

export function previewSandboxName(prNumber: number): string {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error(`invalid preview PR number: ${prNumber}`);
  }
  return `kortix-preview-pr-${prNumber}`;
}

export function selectStalePreviewSandboxIds(
  sandboxes: PreviewSandboxRecord[],
  activePullRequests: ReadonlyMap<number, string>,
): string[] {
  return sandboxes
    .filter((sandbox) => sandbox.metadata?.owner === 'kortix-preview')
    .filter((sandbox) => {
      const prNumber = Number(sandbox.metadata?.pr_number);
      const activeSha = activePullRequests.get(prNumber);
      return !activeSha || activeSha !== sandbox.metadata?.git_sha;
    })
    .map((sandbox) => sandbox.id);
}

export async function runSandboxPreview(
  input: SandboxPreviewInput,
  runners: {
    platinum: (input: SandboxPreviewInput) => Promise<SandboxPreviewResult>;
    daytona: (input: SandboxPreviewInput) => Promise<SandboxPreviewResult>;
  },
): Promise<SandboxPreviewResult> {
  if (input.provider === 'platinum') return runners.platinum(input);
  if (input.provider === 'daytona') return runners.daytona(input);
  try {
    return await runners.platinum(input);
  } catch (error) {
    if (!(error instanceof PreviewInfrastructureError)) throw error;
    console.warn(`[sandbox-preview] Platinum infrastructure failed; fallback=daytona error=${error.message}`);
    return runners.daytona(input);
  }
}
