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

# Authenticate the fetch when we were given a token.
#
# GitHub answers this sandbox's ref advertisement anonymously and then REFUSES
# the fetch that follows. Measured 2026-09-02 from the pi.kortix.com sandbox:
# GET /info/refs?service=git-upload-pack returned 200 ten times out of ten while
# POST /git-upload-pack returned 401 with www-authenticate: Basic realm="GitHub",
# and \`git ls-remote\` failed 10 times out of 10. The repository is PUBLIC —
# GitHub throttles unauthenticated fetches from that datacenter range, and it
# does it on the expensive request only, which is why a plain curl of the GET
# looks perfectly healthy. The checkout phase exited 128 and every deploy went
# red while pi.kortix.com sat on an older commit.
#
# The helper is written as its own FILE rather than inlined into
# \`git config credential.helper "!f() { ... }"\`. That inline form is a quoting
# trap: the nested double quotes collapse, the shell expands the \$(cat ...) at
# config time, and git stores the literal token in .git/config — verified by
# doing exactly that. A file keeps the token out of .git/config, out of this
# script (which lands in the sandbox mode 0755), and out of the remote URL.
#
# No token => anonymous, exactly as before. Most sandboxes are not throttled and
# a preview must not start REQUIRING a credential it never needed.
if [ -s "$STATE/.checkout-token" ]; then
  cat > "$STATE/.checkout-credential-helper" <<'KORTIX_CRED_HELPER'
#!/bin/sh
# Only the "get" operation returns anything; store/erase are no-ops.
[ "$1" = get ] || exit 0
echo username=x-access-token
echo "password=$(cat /workspace/kortix-preview/.checkout-token)"
KORTIX_CRED_HELPER
  chmod 0700 "$STATE/.checkout-credential-helper"
  git -C "$ROOT" config credential.helper "$STATE/.checkout-credential-helper"
else
  git -C "$ROOT" config --unset-all credential.helper 2>/dev/null || true
fi
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

# Reclaim BEFORE pulling, not only after.
#
# There is a prune at the end of this script, and it is the right steady-state
# one: it runs once the new stack is proven healthy, when the running
# containers pin exactly the images worth keeping. But it is gated on that
# health check, and a full disk is precisely the condition under which the
# stack never becomes healthy — supabase-db crash-loops on \`could not write
# lock file "postmaster.pid": No space left on device\`, preview-edge never
# starts, and the deploy dies before reaching the cleanup that would have
# fixed it. The cleanup sat behind the failure it was meant to prevent.
#
# So: a second prune, ahead of a ~3 GB pull, gated on the disk actually being
# tight. \`image prune -af\` spares any image a container references — running,
# created or exited — so the stack still standing here keeps everything it
# needs, and this only reclaims what previous deploys superseded.
used="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
echo "disk before pull: $used%" >&2
if [ "\${used:-0}" -ge 80 ]; then
  docker image prune -af >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
  df -h / | tail -1 >&2
fi
${compose} pull --policy always frontend kortix-api llm-gateway preview-edge mailpit

# Restart anything RUNNING-BUT-UNHEALTHY before waiting on it.
#
# \`compose up -d\` recreates a container for a new image, env or port (see the
# Caddyfile note below) and for NOTHING else — so a long-running container that
# has gone unhealthy is left exactly as it is, forever. Every dependent then
# fails \`depends_on: service_healthy\`, \`--wait\` times out, and the deploy dies
# without ever touching the thing that is actually broken. The retry below does
# not help either: attempt 2 runs the same comparison and reaches the same
# no-op.
#
# Cost of that gap, measured 2026-08-29 on the pi-worker environment:
# supabase-kong sat \`Up 27 hours (unhealthy)\` while still routing traffic, so
# nothing looked wrong from outside. The next deploy — an unrelated one-line
# Mailpit change — could not start a single dependent, and FOUR consecutive
# deploys across two different commits died on it. The whole origin was down
# until the container was restarted by hand.
#
# A restart, never a recreate: the container keeps its volumes and its config,
# so this is safe for stateful services too (postgres included) and cannot lose
# data. Best-effort — a box with nothing unhealthy prints nothing and moves on.
unhealthy="$(docker ps --filter health=unhealthy --format '{{.Names}}' | grep "^kortix-${instance}-" || true)"
if [ -n "$unhealthy" ]; then
  printf 'restarting unhealthy containers before wait: %s\n' "$(printf '%s' "$unhealthy" | tr '\n' ' ')"
  printf '%s\n' "$unhealthy" | xargs -r docker restart
  sleep 5
fi

for stack_attempt in 1 2; do
  if ${compose} up -d --wait --wait-timeout 300; then
    break
  fi
  test "$stack_attempt" -lt 2
  printf 'stack readiness failed on attempt %s; retrying once after container restarts\n' "$stack_attempt"
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

# A branch environment is REUSED, so nothing ever reclaims the images it
# replaces: every deploy pulls ~3 GB of new api/frontend/gateway layers and the
# ones they supersede stay on a 50 GB disk forever. It reached 100% and the
# stack stopped coming up; 22 GB had to be pruned by hand. Prune here, AFTER the
# new stack is proven healthy — the running containers hold references to their
# own images, so this can only take the ones nothing runs from any more.
#
# NO age filter. \`until=24h\` was the first attempt and it reclaimed 0 B: a
# branch environment redeploys several times a day, so every superseded image
# is younger than a day. Without the filter the same box went 90% -> 46% (20.35
# GB) with all 12 services still running. Never fatal: a healthy deploy must not
# fail because a prune did.
df -h / | tail -1 >&2
docker container prune -f >/dev/null 2>&1 || true
docker image prune -af >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true
df -h / | tail -1 >&2

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

/**
 * Sandboxes the nightly sweep should delete.
 *
 * Both owners are reaped, by DIFFERENT rules, because they promise different
 * things. An ephemeral preview is pinned to one commit, so a moved head makes it
 * stale. A branch environment is pinned to a BRANCH and redeployed in place, so
 * a moved head is its normal state — only the pull request leaving the active
 * set retires it, which is what closing it or removing the `preview` label does,
 * and deleting the branch does both.
 *
 * `activePullRequests` holds only OPEN pull requests carrying the `preview`
 * label, so "not in the map" already means "no longer approved".
 */
export function selectStalePreviewSandboxIds(
  sandboxes: PreviewSandboxRecord[],
  activePullRequests: ReadonlyMap<number, string>,
): string[] {
  return sandboxes
    .filter((sandbox) => {
      const owner = sandbox.metadata?.owner;
      if (owner !== 'kortix-preview' && owner !== 'kortix-branch-env') return false;
      const activeSha = activePullRequests.get(Number(sandbox.metadata?.pr_number));
      if (!activeSha) return true;
      return owner === 'kortix-preview' && activeSha !== sandbox.metadata?.git_sha;
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
