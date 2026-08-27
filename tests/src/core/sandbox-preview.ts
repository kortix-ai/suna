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
  nohup dockerd --host=unix:///var/run/docker.sock > "$STATE/dockerd.log" 2>&1 &
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

/**
 * A PERSISTENT per-branch environment, as opposed to the ephemeral per-PR
 * preview above.
 *
 * The difference that matters is lifecycle, not shape: a PR preview is deleted
 * and recreated on every head change (so its sandbox id — and therefore its
 * URL — changes every push), while a branch environment is created ONCE and
 * redeployed in place. Reusing the sandbox is what makes the URL stable enough
 * to bookmark, to register a Stripe webhook against, and to keep a signed-in
 * session and its Postgres volume across deploys.
 */
export function branchEnvSandboxName(branch: string): string {
  const slug = branch.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid branch for a persistent environment: ${branch}`);
  return `kortix-env-${slug}`;
}

export function previewSandboxName(prNumber: number): string {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error(`invalid preview PR number: ${prNumber}`);
  }
  return `kortix-preview-pr-${prNumber}`;
}

export interface PreviewSandboxIdentity {
  name: string;
  owner: 'kortix-preview' | 'kortix-branch-env';
  autoArchiveDays: number;
  autoDeleteDays: number;
  reuseExisting: boolean;
}

/**
 * Who a deploy's sandbox belongs to and how long it lives. The two modes differ
 * only here — everything downstream (template, bootstrap, ingress) is identical.
 *
 * A PR preview is disposable: named after the PR, owned by `kortix-preview`,
 * replaced on every head change, and swept after 7 idle days. `kortix-preview`
 * is also the owner `selectStalePreviewSandboxIds` reconciles on, so a PR
 * preview whose PR closed is deleted by the nightly sweep.
 *
 * A branch environment is a standing deployment: named after the BRANCH, owned
 * by `kortix-branch-env`, reused in place, and never auto-archived or
 * auto-deleted. Reuse is what holds the sandbox id — and therefore the public
 * URL — still, so the environment can be bookmarked, registered as a Stripe
 * webhook target, and keep its Postgres volume across deploys. The distinct
 * owner is what keeps the nightly sweep from reaping it: it has no PR to close.
 */
export function previewSandboxIdentity(input: {
  prNumber: number;
  branchEnv?: string;
}): PreviewSandboxIdentity {
  if (input.branchEnv) {
    return {
      name: branchEnvSandboxName(input.branchEnv),
      owner: 'kortix-branch-env',
      autoArchiveDays: 0,
      autoDeleteDays: 0,
      reuseExisting: true,
    };
  }
  return {
    name: previewSandboxName(input.prNumber),
    owner: 'kortix-preview',
    autoArchiveDays: 7,
    autoDeleteDays: 7,
    reuseExisting: false,
  };
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
