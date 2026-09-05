import { buildPreviewGuardInstall } from './preview-guard';

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
  /** Where people go. The stable name when there is one, else `sandboxOrigin`. */
  previewUrl?: string;
  /**
   * The provider-issued origin, always. A stable name is served by a proxy that
   * has to be told where to send traffic, and this is what it is told.
   */
  sandboxOrigin?: string;
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
  /** Present on Platinum records; teardown matches on it as well as ownership. */
  name?: string;
  metadata?: Record<string, unknown>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The image the self-healing guard runs from: the same docker:cli the
 * self-host updater already pins, so it is present on a warm sandbox and
 * installing the guard never needs a pull.
 */
export const PREVIEW_DOCKER_CLI_IMAGE =
  'docker:29.6.1-cli@sha256:862099ada15c669000bef53aa4cb9d821262829f45b0dda2159ccb276443043b';

export function buildPreviewBootstrapScript(input: {
  repository: string;
  ref: string;
  sha: string;
  prNumber: number;
  origin: string;
  /**
   * Run the full suite inside the environment once it is up. Default true.
   *
   * A PR preview exists to be a gate, so it runs it. A branch environment
   * exists to be WORKED IN, and the suite is ~10 of the ~14 minutes a deploy
   * takes — a tax on every push that proves nothing the health check above
   * has not already proved. Run it there on demand instead.
   */
  runTests?: boolean;
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
# A reused branch sandbox keeps the rootfs of the template it was created
# from, so its pnpm store can predate a dependency the branch has since added.
# Offline is the fast path; when the store is short of a tarball, repair it
# from the frozen lockfile instead of failing the deploy at checkout — which is
# how every pi-worker deploy died on @earendil-works/pi-agent-core on
# 2026-09-04 while the stack behind the public name stayed down.
pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile

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

# The self-healing guard, installed before anything below can fail so that a
# deploy which dies at configure or stack still leaves a watcher behind. See
# tests/src/core/preview-guard.ts.
${buildPreviewGuardInstall({ stateDir: state, instance, dockerCliImage: PREVIEW_DOCKER_CLI_IMAGE })}
printf 'configure\n' > "$PHASE"
bun apps/cli/src/index.ts self-host init --yes --local-images --no-restrict-account-creation --instance ${instance}
PREVIEW_INSTANCE_DIR=${shellQuote(instanceDir)} \
PREVIEW_STATE_DIR=${shellQuote(state)} \
PREVIEW_ORIGIN=${shellQuote(origin.origin)} \
PREVIEW_SHA=${shellQuote(input.sha)} \
PREVIEW_SECRETS_FILE="$SECRETS" \
bun tests/bin/preview-stack.ts

printf 'stack\n' > "$PHASE"

# Reclaim BEFORE pulling. A full disk is precisely the state in which the
# stack cannot become healthy — supabase-db crash-loops on \`could not write
# lock file "postmaster.pid": No space left on device\` — and every deploy adds
# ~2.5 GB of images that nothing else removes. \`image prune -af\` spares any
# image a container references (running, created or exited), so the stack
# standing here keeps everything it needs; only superseded deploys go.
# Measured on the pi-worker branch environment 2026-09-04: 34 GB of images, 25 GB unreferenced,
# 0 bytes free, every container in Created.
used="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
echo "disk before pull: \${used:-?}%" >&2
if [ "\${used:-0}" -ge 70 ]; then
  docker image prune -af >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
  df -h / | tail -1 >&2
fi

# When the NEW stack cannot come up, put the LAST GOOD one back rather than
# leaving nothing serving. The image tags live in the instance .env, and the
# health check below saves a copy of the .env that last proved healthy; a
# failed deploy then restores it and brings that stack up before reporting
# failure, so the public name keeps answering on the previous commit. The
# deploy still fails — this is a fallback, not a pass.
restore_last_good() {
  if [ -f "$STATE/last-good.env" ]; then
    echo "stack failed on this commit; restoring the last good image set" >&2
    cp "$STATE/last-good.env" ${shellQuote(`${instanceDir}/.env`)}
    ${compose} up -d --wait --wait-timeout 300 >&2 || true
  fi
  exit 1
}

${compose} pull --policy always frontend kortix-api llm-gateway preview-edge mailpit
for stack_attempt in 1 2; do
  if ${compose} up -d --wait --wait-timeout 300; then
    break
  fi
  test "$stack_attempt" -lt 2 || restore_last_good

  # WHY THE STACK FAILED, in the log, before anything retries.
  #
  # \`compose up -d\` prints container STATE and never container OUTPUT, so a
  # one-shot service that exits non-zero produced exactly one line —
  # \`service "kortix-migrate" didn't complete successfully: exit 1\` — and the
  # reason for that 1 was nowhere. A branch environment's public name served a
  # 502 for hours behind a log that could not say why (2026-08-29). \`kortix-migrate\` is the one
  # service that can fail this way; the health-gated ones report through
  # \`--wait\`.
  printf '::group::kortix-migrate output (attempt %s)\n' "$stack_attempt"
  ${compose} logs --no-color --tail 200 kortix-migrate 2>&1 || true
  printf '::endgroup::\n'
  ${compose} ps --all --format '{{.Service}}\t{{.State}}\t{{.Status}}' 2>&1 || true

  # A branch environment REUSES its sandbox, so a container left behind by a
  # previous failed deploy is still there — and Docker refuses to recreate a
  # name it already holds:
  #   Conflict. The container name "/…_kortix-pr-NNNN-kortix-migrate-1" is
  #   already in use by container "c18af76fa9df…"
  # That made every failure poison the next deploy. Clear the wreckage before
  # retrying rather than retrying into it. Deliberately WITHOUT \`-v\`: the
  # named volumes carry this environment's Postgres, and the whole point of a
  # branch environment is that its data outlives a redeploy.
  printf 'stack readiness failed on attempt %s; clearing containers and retrying\n' "$stack_attempt"
  ${compose} down --remove-orphans --timeout 30 2>&1 || true
  sleep 10
done

# The Caddyfile is a BIND MOUNT, so rewriting it changes nothing that
# \`compose up -d\` compares — it recreates a container for a new image, env or
# port, never for new bytes in a mounted file — and Caddy does not watch its
# config either. On a reused sandbox the edge therefore keeps serving the config
# it loaded on first boot. That silently pins the WRONG X-Forwarded-Host after
# the public name changes, and Next kills every Server Action when it does not
# match \`origin\` (React #441 — the whole auth flow). Reload explicitly; it is
# idempotent and costs nothing on a fresh container.
${compose} exec -T preview-edge caddy reload --config /etc/caddy/Caddyfile

# Ask the edge container directly rather than through the public name. What is
# being proven here is that THIS stack came up on THIS commit, and a stable
# public name is served by a proxy that is only re-pointed at this sandbox after
# the deploy returns — so going out through it would deadlock the first deploy
# and, on later ones, would answer from the PREVIOUS sandbox. The public path is
# proven separately, by the workflow, once the proxy has been pointed.
HEALTH=http://127.0.0.1:8080/v1/health
for _ in $(seq 1 60); do
  health="$(curl -fsS --max-time 5 "$HEALTH" 2>/dev/null || true)"
  if printf '%s' "$health" | jq -e --arg sha ${shellQuote(input.sha)} '.status == "ok" and .environment == "preview" and .commit == $sha' >/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 10 "$HEALTH" | jq -e --arg sha ${shellQuote(input.sha)} '.status == "ok" and .environment == "preview" and .commit == $sha' >/dev/null
# This image set is proven; it is what restore_last_good falls back to.
cp ${shellQuote(`${instanceDir}/.env`)} "$STATE/last-good.env"

${
    input.runTests === false
      ? `printf 'tests-skipped\\n' > "$PHASE"
printf 'suite skipped — this is a branch environment, not a gate. Run it with:\\n' >&2
printf '  cd %s && set -a && . %s && set +a && pnpm test -- --target-full\\n' "$ROOT" ${shellQuote(`${instanceDir}/.env.test`)} >&2`
      : `printf 'tests\\n' > "$PHASE"
set -a
source ${shellQuote(`${instanceDir}/.env.test`)}
set +a
pnpm test -- --target-full`
  }

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
 * owner is what makes the sweep judge it by its BRANCH rather than by its pull
 * request, so closing the pull request does not retire it.
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

/**
 * Sandboxes to delete, in whichever shape the pull request deployed.
 *
 * Either key may be given. `prNumber` matches the ephemeral preview named after
 * it; `branchEnv` matches the persistent environment named after the branch. A
 * branch-deleted event knows the branch but no pull request, so the persistent
 * match does not require one — the branch IS that environment's identity, two
 * pull requests cannot share it, and ownership is still checked so this can only
 * ever return a sandbox this system created.
 *
 * `branchEnv` must be passed whenever a persistent environment exists: it has NO
 * provider expiry (`autoDeleteDays: 0`), so if teardown does not find it,
 * nothing ever will.
 */
export function selectTeardownSandboxIds(
  sandboxes: PreviewSandboxRecord[],
  input: { prNumber?: number; branchEnv?: string },
): string[] {
  const ephemeral = input.prNumber === undefined ? null : previewSandboxName(input.prNumber);
  const persistent = input.branchEnv ? branchEnvSandboxName(input.branchEnv) : null;
  if (ephemeral === null && persistent === null) {
    throw new Error('preview teardown needs a pull request number or a branch');
  }
  return sandboxes
    .filter((sandbox) => {
      const owner = sandbox.metadata?.owner;
      if (
        ephemeral !== null &&
        sandbox.name === ephemeral &&
        owner === 'kortix-preview' &&
        Number(sandbox.metadata?.pr_number) === input.prNumber
      ) {
        return true;
      }
      return persistent !== null && sandbox.name === persistent && owner === 'kortix-branch-env';
    })
    .map((sandbox) => sandbox.id);
}

/**
 * Sandboxes the nightly sweep should delete.
 *
 * The two owners are retired by different facts, because they are identified by
 * different things. An EPHEMERAL preview belongs to one commit of one pull
 * request, so a closed pull request or a moved head makes it stale. A BRANCH
 * environment belongs to the branch: it is redeployed in place, outlives the
 * pull request being closed, and is retired only when the branch itself is
 * gone. `liveBranchSandboxNames` therefore carries the slugged name of every
 * branch that currently exists on the remote.
 */
export function selectStalePreviewSandboxIds(
  sandboxes: PreviewSandboxRecord[],
  activePullRequests: ReadonlyMap<number, string>,
  liveBranchSandboxNames: ReadonlySet<string> = new Set(),
): string[] {
  return sandboxes
    .filter((sandbox) => {
      const owner = sandbox.metadata?.owner;
      if (owner === 'kortix-branch-env') {
        // The name is the ONLY record of which branch this is — nothing puts
        // the branch in metadata. Without one the sandbox cannot be judged, so
        // it is kept: an unidentifiable box costs money, while deleting one on
        // a listing that stopped returning names would destroy every branch
        // environment and its Postgres volume at once, irreversibly.
        if (sandbox.name === undefined) return false;
        return !liveBranchSandboxNames.has(sandbox.name);
      }
      if (owner !== 'kortix-preview') return false;
      const activeSha = activePullRequests.get(Number(sandbox.metadata?.pr_number));
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
