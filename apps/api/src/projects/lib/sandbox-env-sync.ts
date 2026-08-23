import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { config } from '../../config';
import { resolveLlmGatewayBaseUrl } from '../../llm-gateway/sandbox-base-url';
import type { ProviderName } from '../../platform/providers';
import {
  intersectSecretGrants,
  listProjectSecretsSnapshotForUser,
  projectSecretsRevision,
} from '../secrets';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionSecretGrant } from './secret-grant';
import { sanitizeSandboxEnv } from './sandbox-env-names';
import {
  agentConfigEtag,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} from './compile-agent-config';
import { waitForDaemonOpencodeReady } from './sandbox-daemon-ready';
import { createCoalescedRunner } from './env-sync-coalescer';
import { SECRET_CAPABILITIES_ENV_NAME } from '../secret-capabilities';
import {
  workspaceModeAllowsFullRepository,
  workspaceModeFromSessionMetadata,
} from './session-sandbox-metadata';
import { resolveSessionNetworkBoundary } from './network-secret-boundary';
import { sandboxBelongsToThisInstance } from '../instance-scope';
import type { NetworkBoundarySecretBinding } from '../../secrets/network-boundary';

/** Resolve the LLM gateway URL used by every supported remote provider. */
export function llmGatewayBaseUrlForProvider(_providerName: ProviderName): string {
  return resolveLlmGatewayBaseUrl(config.KORTIX_URL);
}

export const SANDBOX_SERVICE_PORT = 8000;
const FANOUT_CONCURRENCY = 6;
const ENV_PUSH_TIMEOUT_MS = 15_000;

/**
 * How long one recorded arm is trusted before the next sync re-arms anyway.
 * Nothing we run mutates a live sandbox's provider-side attachment behind our
 * back, so this is not correctness — it is a self-heal for drift we did not
 * cause (a provider-side loss of the attachment). Long enough that an ordinary
 * session never pays for it twice; short enough that drift clears without a
 * deploy.
 */
const BOUNDARY_ARM_TTL_MS = 10 * 60_000;
/** Cap on remembered sandboxes. Entries are only ~120 bytes, but the process is
 *  long-lived and external ids are never reused, so the map must be bounded. */
const BOUNDARY_ARM_CACHE_MAX = 2_000;
/**
 * The longest a user's turn blocks on the binding record landing.
 *
 * The update is NOT abandoned at this deadline — it keeps running and records
 * its result — we just stop making the person wait for it. Blocking a turn for
 * a provider's full credential-arm budget is what pushed
 * `POST /session/{id}/prompt_async` past the proxy budget and returned 502.
 * That provider edge is gone, so the wait is now a formality; the budget stays
 * so no future work on this path can reintroduce the stall.
 */
const PROMPT_BOUNDARY_ARM_WAIT_MS = 1_500;

/** `secretIds` is what the edge is currently holding. Kept because the digest
 *  alone cannot tell a WIDENING from a REVOCATION, and the two need opposite
 *  failure handling — see the shrink check in `syncSandboxEnvForPrompt`. */
type BoundaryArmRecord = { digest: string; armedAt: number; secretIds: string[] };

/**
 * Per-sandbox record of the LAST binding set this process successfully armed.
 *
 * In-process on purpose: it is a cost optimization, not state anyone reads for
 * a decision. A fresh API replica (deploy, scale-out, restart) simply misses and
 * performs exactly one re-arm for that sandbox — the same call it would have
 * made anyway, applying the same desired state, so a miss is always safe.
 */
const armedNetworkBoundaries = new Map<string, BoundaryArmRecord>();
/** In-flight arms, so two prompts on one sandbox never race two PUTs at the
 *  provider. Same digest joins; a different digest queues behind it. */
const inFlightNetworkBoundaries = new Map<string, { digest: string; done: Promise<void> }>();

/** Test seam: drop every remembered arm so a case starts from a cold replica. */
export function __resetNetworkBoundaryArmCacheForTests(): void {
  armedNetworkBoundaries.clear();
  inFlightNetworkBoundaries.clear();
}

/**
 * Per-sandbox record of the last `refreshModels`-relevant payload this process
 * delivered to the daemon on the PER-PROMPT hot path (`syncSandboxEnvForPrompt`).
 *
 * T3: every `/prompt_async|/message|/command` used to post
 * `refreshModels: true` unconditionally. The daemon's `/kortix/env` already
 * gates the actual reload on a value DELTA (`routes/env.ts`'s
 * `result.changed || opencodeEnvChanged`), so a byte-identical resend never
 * disposes/respawns OpenCode by itself — but it still pays for the comparison
 * on every turn, and it is the only signal the daemon has: this cache lets the
 * API stop asking at all once nothing config-affecting has moved, so a client
 * bug or a future daemon change can't turn a no-op post into a live reload.
 *
 * In-process on purpose, same reasoning as `armedNetworkBoundaries`: it is a
 * cost optimization, not state anyone reads for a decision. A fresh API
 * replica (deploy, scale-out, restart) misses and sends `refreshModels: true`
 * once for that sandbox — never less correct, only a single extra no-op
 * comparison on the daemon.
 */
const lastPromptModelSignature = new Map<string, string>();
/**
 * When each box last had its env pushed successfully. Together with the
 * signature above this is the "nothing to say" short-circuit: a prompt whose
 * whole env set is byte-identical to what THIS process pushed to THIS box
 * within `PROMPT_ENV_PUSH_TTL_MS` skips the daemon round-trip entirely. That
 * round-trip was ~1s of dead air on every send in a queue burst and every
 * back-to-back turn, for a push the daemon itself would no-op. Bounded by a
 * TTL because the box can respawn its daemon underneath us; the next prompt
 * past the TTL re-pushes, and any signature change re-pushes at once.
 */
const lastPromptEnvPushAt = new Map<string, number>();
export const PROMPT_ENV_PUSH_TTL_MS = 2 * 60_000;
/** Entries are ~200 bytes; the process is long-lived and external ids are
 *  never reused, so this must be bounded the same way `armedNetworkBoundaries`
 *  is. No TTL: unlike the boundary arm this is not self-healing drift, it is a
 *  pure memo of "what did we last tell this box", so eviction on capacity
 *  (oldest-write-first, same as the boundary cache) is enough. */
const PROMPT_MODEL_SIGNATURE_CACHE_MAX = 2_000;

/** Test seam: drop every remembered per-prompt signature. */
export function __resetPromptModelSignatureCacheForTests(): void {
  lastPromptModelSignature.clear();
  lastPromptEnvPushAt.clear();
}

/**
 * Digest of EVERY value `syncSandboxEnvForPrompt` sends that can move the
 * daemon's `result.changed || opencodeEnvChanged` gate (`routes/env.ts:196`):
 *
 *   - `snapshot.revision` — a sha256 of the full granted project-secrets env
 *     (`projectSecretsRevision`), so any secret add/remove/rotation changes it.
 *     This is NOT limited to "model-relevant" secrets on purpose: a project
 *     secret delta is the daemon's ONLY signal to respawn opencode so its
 *     process env picks the new value up (see the comment on
 *     `pushSessionScopeToSandbox`), and the per-turn sync is sometimes the
 *     only path that ever re-delivers it (see `runPrePromptEnvSync`'s comment
 *     on `/command` self-heal). Narrowing this to a "model tokens" subset
 *     would silently stop propagating an unrelated secret rotation.
 *   - `snapshot.capabilitiesJson` — pushed as `KORTIX_SECRET_CAPABILITIES`,
 *     which is on the daemon's `RESPAWN_REQUIRED_ENV_NAMES` list.
 *   - the LLM-gateway mode and base URL.
 *   - `args.opencodeEnv` — an explicit runtime-env push a caller asked this
 *     same call to carry (e.g. a channel follow-up's `KORTIX_CONNECTORS_MCP_ENABLED`,
 *     see `continueSession`/engine.ts). Omitting it would silently drop that
 *     caller's request to apply its own change.
 *
 * Keys of `opencodeEnv` are sorted so caller-side object literal order never
 * produces a spurious digest change.
 */
function promptModelSignature(input: {
  revision: string;
  capabilitiesJson: string;
  /** Still per-provider (origin) and per-catalog-revision, hence in the digest.
   *  Gateway mode itself is constant (always on) and is not an input. */
  llmGatewayBaseUrl?: string;
  opencodeEnv?: Record<string, string | null>;
}): string {
  const opencodeEnvEntries = Object.entries(input.opencodeEnv ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify([
    input.revision,
    input.capabilitiesJson,
    input.llmGatewayBaseUrl ?? '',
    opencodeEnvEntries,
  ]);
}

function rememberPromptModelSignature(externalId: string, signature: string): void {
  lastPromptEnvPushAt.set(externalId, Date.now());
  if (lastPromptEnvPushAt.size > PROMPT_MODEL_SIGNATURE_CACHE_MAX) {
    const oldest = lastPromptEnvPushAt.keys().next();
    if (!oldest.done) lastPromptEnvPushAt.delete(oldest.value);
  }
  lastPromptModelSignature.delete(externalId);
  if (lastPromptModelSignature.size >= PROMPT_MODEL_SIGNATURE_CACHE_MAX) {
    const oldest = lastPromptModelSignature.keys().next();
    if (!oldest.done) lastPromptModelSignature.delete(oldest.value);
  }
  lastPromptModelSignature.set(externalId, signature);
}

/**
 * Identity of the binding set this sandbox carries.
 *
 * Keyed on everything that changes what a session may spend — the secret
 * (`secretId`), its stable alias, and the policy (`hosts`, and the legacy
 * `header` when a row still injects). A widened host list therefore produces a
 * different digest and IS recorded again; only a byte-identical desired state
 * is skipped. Order-independent, because binding order carries no meaning.
 *
 * No credential material is hashed, because none reaches here: the value is
 * fetched by the broker route per request and never enters a binding.
 */
function networkBoundaryDigest(
  providerName: ProviderName,
  bindings: NetworkBoundarySecretBinding[],
): string {
  const material = bindings
    .map((binding) =>
      JSON.stringify([
        binding.secretId,
        binding.alias,
        [...binding.hosts].map((host) => host.toLowerCase()).sort(),
        binding.header?.toLowerCase() ?? null,
      ]),
    )
    .sort()
    .join('\n');
  return createHash('sha256').update(`${providerName}\n${material}`).digest('hex');
}

function rememberNetworkBoundaryArm(externalId: string, digest: string, secretIds: string[]): void {
  armedNetworkBoundaries.delete(externalId);
  if (armedNetworkBoundaries.size >= BOUNDARY_ARM_CACHE_MAX) {
    const cutoff = Date.now() - BOUNDARY_ARM_TTL_MS;
    for (const [key, record] of armedNetworkBoundaries) {
      if (record.armedAt <= cutoff) armedNetworkBoundaries.delete(key);
    }
    // Still full of live entries — evict the least recently written. Map
    // iteration is insertion order and every refresh deletes before it sets,
    // so the first key is the oldest write.
    while (armedNetworkBoundaries.size >= BOUNDARY_ARM_CACHE_MAX) {
      const oldest = armedNetworkBoundaries.keys().next();
      if (oldest.done) break;
      armedNetworkBoundaries.delete(oldest.value);
    }
  }
  armedNetworkBoundaries.set(externalId, { digest, armedAt: Date.now(), secretIds: [...secretIds] });
}

/**
 * Record the binding set this sandbox is serving.
 *
 * There is nothing to register with a provider any more. One mechanism serves
 * every provider (docs/specs/2026-08-19-secrets-exposure-usage-model.md §4):
 * the guest holds a HANDLE, the broker route substitutes the real value
 * server-side on an approved host, and the value never enters the sandbox on
 * daytona, e2b or platinum alike. The Platinum credential edge is gone, so this
 * is bookkeeping — it keeps the digest/skip and revocation accounting the
 * callers below still read, and it is async because it is awaited as a promise
 * everywhere.
 */
function startNetworkBoundaryArm(
  externalId: string,
  bindings: NetworkBoundarySecretBinding[],
  digest: string,
): Promise<void> {
  const previous = inFlightNetworkBoundaries.get(externalId);
  if (previous?.digest === digest) return previous.done;
  // A different desired set must not race the one already in flight: the record
  // is last-write-wins, so two overlapping updates could leave the memo on the
  // older set. Queue instead.
  const done = (previous?.done ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      try {
        rememberNetworkBoundaryArm(
          externalId,
          digest,
          bindings.map((binding) => binding.secretId),
        );
      } finally {
        if (inFlightNetworkBoundaries.get(externalId)?.done === done) {
          inFlightNetworkBoundaries.delete(externalId);
        }
      }
    });
  inFlightNetworkBoundaries.set(externalId, { digest, done });
  return done;
}

/**
 * Record this session's network-boundary binding set.
 *
 * Returns `'skipped'` when there is nothing to do (no bindings, or this sandbox
 * already carries this exact set), `'armed'` when the record landed, and
 * `'pending'` when the caller's wait budget expired first.
 *
 * `maxWaitMs` is the CALLER's patience, not the update's deadline. Omit it — as
 * the secret fan-out does — to wait for the real result and report a failure.
 */
async function syncProviderNetworkBoundary(
  providerName: ProviderName,
  externalId: string,
  bindings: NetworkBoundarySecretBinding[],
  opts?: { maxWaitMs?: number },
): Promise<'skipped' | 'armed' | 'pending'> {
  if (bindings.length === 0) return 'skipped';
  const digest = networkBoundaryDigest(providerName, bindings);
  const armed = armedNetworkBoundaries.get(externalId);
  if (armed?.digest === digest && Date.now() - armed.armedAt < BOUNDARY_ARM_TTL_MS) {
    return 'skipped';
  }

  const attempt = startNetworkBoundaryArm(externalId, bindings, digest);
  const maxWaitMs = opts?.maxWaitMs;
  if (!maxWaitMs) {
    await attempt;
    return 'armed';
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      // Both legs are handled here, so a rejection that lands AFTER the timeout
      // wins is still consumed — it can never surface as an unhandled rejection.
      attempt.then(
        () => 'armed' as const,
        (error: unknown) => ({ error }),
      ),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), maxWaitMs);
      }),
    ]);
    if (typeof outcome === 'object') throw outcome.error;
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SandboxEnvSnapshot {
  env: Record<string, string>;
  names: string[];
  revision: string;
  scope: 'inherit' | 'restricted' | 'none';
  capabilitiesJson: string;
}

export interface ProjectSecretPropagationTarget {
  session_id: string;
  sandbox_id: string | null;
  status: 'synced' | 'failed';
  scope: SandboxEnvSnapshot['scope'] | null;
  revision: string | null;
  exported: number;
  managed: number | null;
  withheld: number | null;
  agent_env_written: boolean;
  reason?: string;
}

export interface ProjectSecretPropagationResult {
  ok: boolean;
  active_sandboxes: number;
  targeted: number;
  synced: number;
  failed: number;
  exported: number;
  results: ProjectSecretPropagationTarget[];
}

async function resolveOwnerRawEnv(
  projectId: string,
  sessionId: string | null,
  requestedAgent?: string | null,
): Promise<{
  env: Record<string, string>;
  capabilitiesJson: string;
  scope: SandboxEnvSnapshot['scope'];
} | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select({
      createdBy: projectSessions.createdBy,
      agentName: projectSessions.agentName,
      secretsAllowlist: projectSessions.secretsAllowlist,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row?.createdBy) return null;

  // Resolve the RUNNING agent's `secrets` grant (by identifier) — the SAME gate
  // applied at sandbox boot (buildSessionSandboxEnvVars), through the SAME
  // resolver (lib/secret-grant.ts), so boot and hot push can never disagree.
  //
  // `requestedAgent` is the agent the prompt actually asked to run, which is
  // NOT necessarily `row.agentName`: in-session agent switching is allowed and
  // nothing ever updates that column. Resolving from the stale column let a
  // session created under a broad agent run a narrow one while still being
  // re-pushed the broad agent's full env on every turn. The hot push replaces
  // the env with the RUNNING agent's grant before the prompt is forwarded. A
  // switch is never refused — see secret-grant.ts for why refusing protected
  // nothing that was still protectable.
  const [project] = await db
    .select({
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);

  const grantEnv = await resolveSessionSecretGrant({
    projectId,
    repoUrl: project?.repoUrl ?? '',
    defaultBranch: project?.defaultBranch,
    manifestPath: project?.manifestPath,
    sessionAgent: row.agentName ?? DEFAULT_AGENT_SENTINEL,
    requestedAgent,
  });

  // THE CLOBBER FIX: apply the SAME per-session secrets narrowing as boot
  // (buildSessionSandboxEnvVars). Without this, the first prompt's env sync (and
  // every secret-CRUD fan-out) would re-push the full agent-grant set into a
  // narrowed sandbox, silently widening it back. null allowlist → passthrough.
  const grantEnvForSession = intersectSecretGrants(grantEnv, row.secretsAllowlist ?? null);
  const snapshot = await listProjectSecretsSnapshotForUser(
    projectId,
    row.createdBy,
    grantEnvForSession,
    // Same session the boot path built for — boot and hot push must agree on
    // delivery or a prompt would re-push a value boot deliberately withheld.
    sessionId,
  );
  return {
    env: snapshot.env,
    capabilitiesJson: snapshot.capabilitiesJson,
    scope:
      row.secretsAllowlist == null
        ? 'inherit'
        : row.secretsAllowlist.length === 0
          ? 'none'
          : 'restricted',
  };
}

export async function resolveSandboxEnvSnapshot(
  projectId: string,
  sessionId: string | null,
  requestedAgent?: string | null,
): Promise<SandboxEnvSnapshot | null> {
  const resolved = await resolveOwnerRawEnv(projectId, sessionId, requestedAgent);
  if (!resolved) return null;
  const { env, names } = sanitizeSandboxEnv(resolved.env);
  return {
    env,
    names,
    revision: projectSecretsRevision(env),
    capabilitiesJson: resolved.capabilitiesJson,
    scope: resolved.scope,
  };
}

function isSecureOrPrivateTarget(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname;
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(h)) return true;
  if (!h.includes('.')) return true; // single-label docker/service name on a private bridge
  if (/\.(local|internal|svc|cluster\.local)$/.test(h)) return true;
  // RFC1918 / link-local — anchored to full IPv4 literals so a public hostname
  // like "10.foo.evil.com" can't slip through a `^10.` prefix match.
  if (/^10(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 unique-local
  return false; // plain http to a public host — refuse to send secrets in cleartext
}

/**
 * The one `POST /kortix/env` every env-push path shares — per-prompt sync,
 * secret fan-out, model/scope/agent-config pushes and boot-time gateway-URL
 * convergence (`gateway-url-convergence.ts`). Exported for that last caller;
 * it is not a public API beyond this directory.
 */
export async function postEnvToDaemon(args: {
  previewUrl: string;
  providerHeaders: Record<string, string>;
  serviceKey: string;
  snapshot: SandboxEnvSnapshot;
  refreshModels?: boolean;
  /** Runtime env the daemon applies to the OPENCODE process (allow-listed there). */
  opencodeEnv?: Record<string, string | null>;
  llmGatewayEnabled?: boolean;
  llmGatewayBaseUrl?: string;
  requireAgentEnvProof?: boolean;
}): Promise<{
  opencodeState: string | null;
  revision: string;
  exported: number;
  managed: number | null;
  withheld: number | null;
  agentEnvWritten: boolean;
  /**
   * How the daemon applied the config, or null when it did not say (an older
   * daemon, or no reload was needed). 'kept-old' is the verified swap
   * declining: the new opencode never came up and the previous one still
   * serves — the push landed, the config did not.
   */
  opencodeReload: 'disposed' | 'restarted' | 'kept-old' | null;
  /**
   * Did applying the config interrupt a turn someone was waiting on?
   * `null` = the box did not say (older daemon, or no reload happened).
   */
  opencodeTurnEnded: boolean | null;
  /**
   * Is the daemon's OpenCode /event subscription live on the process serving
   * after the reload? `null` = no reload, or an older daemon that does not say.
   */
  eventSubscriptionLive: boolean | null;
}> {
  if (!isSecureOrPrivateTarget(args.previewUrl)) {
    throw new Error('refusing to push secrets over insecure transport (non-TLS public host)');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${args.serviceKey}`,
    ...args.providerHeaders,
  };

  const res = await fetch(`${args.previewUrl.replace(/\/$/, '')}/kortix/env`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      env: args.snapshot.env,
      names: args.snapshot.names,
      revision: args.snapshot.revision,
      refreshModels: args.refreshModels ?? false,
      opencodeEnv: {
        ...(args.opencodeEnv ?? {}),
        [SECRET_CAPABILITIES_ENV_NAME]: args.snapshot.capabilitiesJson,
      },
      ...(typeof args.llmGatewayEnabled === 'boolean'
        ? {
            llmGatewayEnabled: args.llmGatewayEnabled,
            ...(args.llmGatewayBaseUrl ? { llmGatewayBaseUrl: args.llmGatewayBaseUrl } : {}),
          }
        : {}),
    }),
    signal: AbortSignal.timeout(ENV_PUSH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`env sync failed: ${res.status}${body ? ` ${body.slice(0, 500)}` : ''}`);
  }
  // The daemon echoes opencode's post-sync state. After a model-affecting change
  // it restarts opencode and reports `starting` here — the signal we use to wait
  // for readiness before the prompt is forwarded.
  const body = (await res.json().catch(() => null)) as {
    ok?: unknown;
    revision?: unknown;
    exported?: unknown;
    managed?: unknown;
    withheld?: unknown;
    agent_env_written?: unknown;
    opencode?: unknown;
    opencode_reload?: unknown;
    opencode_turn_ended?: unknown;
    event_subscription_live?: unknown;
  } | null;
  const expectedExported = Object.keys(args.snapshot.env).length;
  if (args.requireAgentEnvProof) {
    if (!body || body.ok !== true) throw new Error('env sync proof missing ok=true');
    if (body.revision !== args.snapshot.revision) {
      throw new Error(`env sync revision mismatch: expected ${args.snapshot.revision}, received ${String(body.revision)}`);
    }
    if (body.agent_env_written !== true) {
      throw new Error('env sync did not confirm agent-env.sh write');
    }
    if (body.exported !== expectedExported) {
      throw new Error(`env sync export mismatch: expected ${expectedExported}, received ${String(body.exported)}`);
    }
  }
  return {
    opencodeState: typeof body?.opencode === 'string' ? body.opencode : null,
    // How the daemon applied the config. 'kept-old' means the verified swap
    // declined: the new opencode never came up, so the running one still
    // serves and the change did NOT take. An older daemon omits the field
    // entirely — null, meaning "could not tell", never "it worked".
    opencodeReload:
      typeof body?.opencode_reload === 'string'
        ? (body.opencode_reload as 'disposed' | 'restarted' | 'kept-old')
        : null,
    opencodeTurnEnded:
      typeof body?.opencode_turn_ended === 'boolean' ? body.opencode_turn_ended : null,
    // Whether the daemon's OpenCode /event subscription is live on the process
    // serving AFTER the reload (the daemon waits ≤2s for it on a restart before
    // answering — routes/env.ts). `false` after a restart names the exact
    // window in which a prompt forwarded now can finish with no `session.idle`
    // listener (2026-08-23, session eddd499a). Older daemons omit it: null.
    eventSubscriptionLive:
      typeof body?.event_subscription_live === 'boolean' ? body.event_subscription_live : null,
    revision: typeof body?.revision === 'string' ? body.revision : args.snapshot.revision,
    exported: typeof body?.exported === 'number' ? body.exported : expectedExported,
    managed: typeof body?.managed === 'number' ? body.managed : null,
    withheld: typeof body?.withheld === 'number' ? body.withheld : null,
    agentEnvWritten: body?.agent_env_written === true,
  };
}

export async function syncSandboxEnvForPrompt(args: {
  projectId: string;
  sessionId: string;
  externalId: string;
  serviceKey: string | null;
  previewUrl: string;
  providerHeaders: Record<string, string>;
  /** The provider this sandbox actually runs on (`SandboxRecord.provider` at
   *  the call site) — needed to resolve the LLM-gateway base URL onto the
   *  RIGHT origin for a same-machine provider. */
  providerName: ProviderName;
  /** The agent this prompt asked to run (the body's `agent` field). The secret
   *  grant is resolved from THIS, not from the session's create-time agent —
   *  see resolveOwnerRawEnv. Null/'default' means "the session's own agent". */
  requestedAgent?: string | null;
  /** Runtime env the daemon applies before the prompt reaches OpenCode. */
  opencodeEnv?: Record<string, string | null>;
}): Promise<void> {
  if (!args.serviceKey) return;
  const t0 = performance.now();
  const timing: Record<string, number> = {};
  const lap = (label: string) => {
    timing[label] = Math.round(performance.now() - t0 - Object.values(timing).reduce((a, b) => a + b, 0));
  };
  const snapshot = await resolveSandboxEnvSnapshot(
    args.projectId,
    args.sessionId,
    args.requestedAgent,
  );
  lap('snapshot');
  if (!snapshot) return;
  // Resolving the bindings stays FAIL-CLOSED: it re-reads the agent's grant, and
  // an unresolvable grant must refuse the prompt (the caller maps
  // SecretGrantResolutionError to its own 503).
  //
  // This line used to be justified with "resolveSandboxEnvSnapshot above already
  // resolved the same grant and threw first". That was false, and it is how the
  // removed grant lock kept 409-ing real switches while its config flag was off:
  // the call above passed the flag explicitly (false, so it did NOT throw) while
  // this leg omitted it and landed on the resolver's `?? true` default, so THIS
  // was the line that threw. The parameter is gone, so the two legs can no
  // longer disagree about policy — they share one resolver with one behavior.
  const networkBoundary = await resolveSessionNetworkBoundary(
    args.projectId,
    args.sessionId,
    args.requestedAgent,
  );
  lap('boundary');
  // Sampled BEFORE the attempt, because a failed arm forgets its record. `true`
  // means this process already armed a DIFFERENT set on this sandbox (an
  // unchanged set never reaches the provider at all), so a failure below leaves
  // the edge holding the PREVIOUS bindings. That is the one case the fail-soft
  // below does not fully cover: a narrowing that does not land keeps a
  // credential injectable at the edge — still never readable in the guest —
  // until the next successful arm. It is logged so it is greppable.
  // A REVOCATION must not fail soft. When the desired set drops a binding this
  // process already recorded, that shrink is the revocation. It is now cheap —
  // the value is fetched per request by the broker route and the guest's handle
  // stops being spendable the moment the grant changes — but the accounting
  // stays raised rather than swallowed: a shrink that does not land is the one
  // direction that can widen what an agent may spend. A widening or a rotation
  // that fails still forwards the turn.
  const priorArm = armedNetworkBoundaries.get(args.externalId);
  const hadPriorArm = priorArm !== undefined;
  const nextSecretIds = new Set(networkBoundary.map((binding) => binding.secretId));
  const revokesArmedBinding = (priorArm?.secretIds ?? []).some((id) => !nextSecretIds.has(id));
  try {
    // A WIDENING, by contrast, fails SOFT — a failed or late record cannot leak.
    // An egress-enforced secret's value never enters the sandbox: the guest gets
    // a handle and the broker route substitutes the value server-side. So
    // skipping this cannot disclose anything; the only consequence is bookkeeping
    // the next call redoes. Failing the turn on it is what made one egress secret
    // 502 EVERY prompt in the project, with the agent unable to run at all.
    //
    // SCOPE: this fail-soft covers the binding record and nothing else. It does
    // not extend to the grant resolution above (failing open there would widen
    // what the agent may read), and it must not be copied into the provision
    // path in platform/services/session-sandbox.ts — a session whose boundary
    // policy is unusable should still fail to provision, loudly.
    const armState = await syncProviderNetworkBoundary(
      args.providerName,
      args.externalId,
      networkBoundary,
      { maxWaitMs: PROMPT_BOUNDARY_ARM_WAIT_MS },
    );
    if (armState === 'pending' && revokesArmedBinding) {
      throw new Error(
        `network-boundary revocation did not land within ${PROMPT_BOUNDARY_ARM_WAIT_MS}ms for ${args.externalId}`,
      );
    }
    if (armState === 'pending') {
      console.warn(
        `[env-sync] network boundary still arming after ${PROMPT_BOUNDARY_ARM_WAIT_MS}ms; ` +
          `forwarding the prompt without waiting session=${args.sessionId} sandbox=${args.externalId} ` +
          `bindings=${networkBoundary.length} replaces-previous-set=${hadPriorArm}`,
      );
    }
  } catch (err) {
    // The one case that must still refuse the turn: an arm that would have
    // REMOVED a binding the edge is holding. See the comment on
    // `revokesArmedBinding`.
    if (revokesArmedBinding) throw err;
    console.warn(
      `[env-sync] network-boundary arm failed; continuing the turn without it ` +
        `session=${args.sessionId} sandbox=${args.externalId} bindings=${networkBoundary.length} ` +
        `replaces-previous-set=${hadPriorArm}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  lap('arm');
  // Gateway mode is the only mode: every push re-stamps mode ON and the base
  // URL for THIS provider's origin. The daemon honours `llmGatewayEnabled:true`
  // on every build, so a box that booted before this rule converges on its
  // next prompt. Native provider keys never reach the sandbox env at all
  // (`materializeSecretDelivery` withholds gateway-managed credentials
  // server-side), so no per-push deny list travels with the mode.
  const llmGatewayEnabled = true;
  const llmGatewayBaseUrl = llmGatewayBaseUrlForProvider(args.providerName);
  // Only ask the daemon to reload when something that could move ITS
  // `result.changed || opencodeEnvChanged` gate has actually changed since the
  // last time THIS process pushed to THIS sandbox. The daemon already no-ops a
  // byte-identical push (see routes/env.ts), but every prompt used to ask
  // anyway — this stops the ask itself, so a future daemon change can't turn a
  // steady-state prompt into a live reload just because `refreshModels` was
  // unconditionally true. See `promptModelSignature` for exactly what is
  // covered (it is NOT limited to "model" fields — project-secret deltas ride
  // the same gate and must never be silently skipped).
  const signature = promptModelSignature({
    revision: snapshot.revision,
    capabilitiesJson: snapshot.capabilitiesJson,
    llmGatewayBaseUrl,
    opencodeEnv: args.opencodeEnv,
  });
  const refreshModels = lastPromptModelSignature.get(args.externalId) !== signature;
  const pushedAt = lastPromptEnvPushAt.get(args.externalId);
  if (
    !refreshModels &&
    pushedAt !== undefined &&
    Date.now() - pushedAt < PROMPT_ENV_PUSH_TTL_MS
  ) {
    // Byte-identical to what this process pushed to this box moments ago:
    // nothing to say, and the daemon would no-op it. Skip the round-trip.
    console.log(`[env-sync] timing sandbox=${args.externalId} push=skipped ${JSON.stringify(timing)}`);
    return;
  }
  const { opencodeState, opencodeReload, eventSubscriptionLive } = await postEnvToDaemon({
    previewUrl: args.previewUrl,
    providerHeaders: args.providerHeaders,
    serviceKey: args.serviceKey,
    snapshot,
    refreshModels,
    opencodeEnv: args.opencodeEnv,
    llmGatewayEnabled,
    llmGatewayBaseUrl,
  });
  if (opencodeReload === 'restarted' && eventSubscriptionLive === false) {
    console.warn(
      `[env-sync] opencode restarted by prompt env-sync but the daemon's /event subscription ` +
        `was not live on the new process within its bound; the prompt is forwarded anyway and the ` +
        `daemon's reconnect reconcile + the /turn read-path reconcile are the backstops session=${args.sessionId}`,
    );
  }
  // Remember only AFTER a successful push. A throw below (network/HTTP
  // failure) must leave the memo alone so the next prompt retries with
  // `refreshModels: true` again instead of assuming the failed attempt landed.
  rememberPromptModelSignature(args.externalId, signature);
  lap('push');
  // A model-affecting change just restarted opencode (state !== 'ok'). The prompt
  // is forwarded the instant this returns, so block until opencode is serving —
  // otherwise the forward hits the restart window and 503s "opencode not ready",
  // dropping the session's first prompt (the user then has to resend).
  if (opencodeState && opencodeState !== 'ok') {
    const waitStartedAt = Date.now();
    const ready = await waitForDaemonOpencodeReady({
      previewUrl: args.previewUrl,
      providerHeaders: args.providerHeaders,
    });
    console.log(
      `[env-sync] opencode restarted by prompt env-sync (state=${opencodeState}); ` +
        `waited ${Date.now() - waitStartedAt}ms for readiness before forwarding ` +
        `(ready=${ready}) session=${args.sessionId}`,
    );
  }
  console.log(
    `[env-sync] timing sandbox=${args.externalId} push=sent refreshModels=${refreshModels} ` +
      `reload=${opencodeReload ?? 'none'} eventSubscriptionLive=${eventSubscriptionLive ?? 'n/a'} ${JSON.stringify(timing)}`,
  );
}

/**
 * The coalesced public entry — see env-sync-coalescer.ts for the incident this
 * exists for (2026-08-21: looping secret writers × per-write fan-out throttled
 * the whole Daytona org). Callers keep their await semantics: an awaited call
 * returns a report from a run that STARTED after their write, so the report
 * covers it; a burst shares one trailing run instead of stacking N fan-outs.
 */
export const propagateProjectSecretsToActiveSandboxes = createCoalescedRunner<
  ProjectSecretPropagationResult
>({
  run: (projectId, opts) => runProjectSecretPropagation(projectId, opts),
  // 3s, not more: single-flight + burst-collapse are what break a storm (50
  // writes → 2 runs regardless of this value); the interval only paces a
  // slow-drip loop. The two AWAITED callers (secret-broker rotation and
  // POST /secrets/sync) sit behind this cooldown too, so it must stay small
  // enough that a human never notices it on those endpoints.
  minIntervalMs: () => {
    const configured = Number((config as any).KORTIX_ENV_SYNC_MIN_INTERVAL_MS);
    return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 3_000;
  },
});

async function runProjectSecretPropagation(
  projectId: string,
  opts?: { refreshModels?: boolean },
): Promise<ProjectSecretPropagationResult> {
  const report: ProjectSecretPropagationResult = {
    ok: true,
    active_sandboxes: 0,
    targeted: 0,
    synced: 0,
    failed: 0,
    exported: 0,
    results: [],
  };
  try {
    const allRows = await db
      .select({
        externalId: sessionSandboxes.externalId,
        sessionId: sessionSandboxes.sessionId,
        provider: sessionSandboxes.provider,
        config: sessionSandboxes.config,
        metadata: sessionSandboxes.metadata,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.projectId, projectId), eq(sessionSandboxes.status, 'active')));
    // INSTANCE SCOPE (shared local DB — ../instance-scope.ts): a box another
    // API instance provisioned must not receive THIS instance's env (its
    // `KORTIX_URL`-derived gateway URL). No-op when KORTIX_INSTANCE_ID is unset.
    const rows = allRows.filter((r) => sandboxBelongsToThisInstance(r.metadata));

    report.active_sandboxes = rows.length;
    const targets = rows.filter((r): r is typeof r & { externalId: string } => !!r.externalId);
    for (const row of rows) {
      if (row.externalId) continue;
      report.results.push({
        session_id: row.sessionId,
        sandbox_id: null,
        status: 'failed',
        scope: null,
        revision: null,
        exported: 0,
        managed: null,
        withheld: null,
        agent_env_written: false,
        reason: 'active sandbox has no external id',
      });
    }
    report.targeted = targets.length;
    if (targets.length === 0) {
      console.info('[env-sync] propagate: no active sandboxes found', { projectId, totalRows: rows.length });
      report.failed = report.results.length;
      report.ok = report.failed === 0;
      return report;
    }
    console.info('[env-sync] propagate: pushing to sandboxes', { projectId, targetCount: targets.length });

    await runBounded(targets, FANOUT_CONCURRENCY, async (row) => {
      const config = (row.config || {}) as Record<string, unknown>;
      const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
      if (!serviceKey) {
        report.results.push({
          session_id: row.sessionId,
          sandbox_id: row.externalId,
          status: 'failed',
          scope: null,
          revision: null,
          exported: 0,
          managed: null,
          withheld: null,
          agent_env_written: false,
          reason: 'active sandbox has no service key',
        });
        return;
      }
      let snapshot: SandboxEnvSnapshot | null = null;
      try {
        snapshot = await resolveSandboxEnvSnapshot(projectId, row.sessionId);
        if (!snapshot) throw new Error('session env snapshot is unavailable');
        const providerName = row.provider as ProviderName;
        const networkBoundary = await resolveSessionNetworkBoundary(projectId, row.sessionId);
        // No wait budget and no fail-soft here. This is the secret-CRUD fan-out:
        // it is the path that DELIVERS a rotated credential to the edge, and its
        // caller reports the per-sandbox outcome to the author who just saved the
        // secret. An arming failure has to be visible there, so it stays a
        // `status: 'failed'` row rather than a warning nobody reads.
        await syncProviderNetworkBoundary(providerName, row.externalId, networkBoundary);
        const { url, headers } = await resolveSandboxIngress(row.externalId, { port: SANDBOX_SERVICE_PORT, transport: 'http' });
        const proof = await postEnvToDaemon({
          previewUrl: url,
          providerHeaders: headers,
          serviceKey,
          snapshot,
          refreshModels: opts?.refreshModels,
          requireAgentEnvProof: true,
        });
        report.results.push({
          session_id: row.sessionId,
          sandbox_id: row.externalId,
          status: 'synced',
          scope: snapshot.scope,
          revision: proof.revision,
          exported: proof.exported,
          managed: proof.managed,
          withheld: proof.withheld,
          agent_env_written: proof.agentEnvWritten,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        report.results.push({
          session_id: row.sessionId,
          sandbox_id: row.externalId,
          status: 'failed',
          scope: snapshot?.scope ?? null,
          revision: snapshot?.revision ?? null,
          exported: 0,
          managed: null,
          withheld: null,
          agent_env_written: false,
          reason,
        });
        console.warn(
          `[env-sync] hot push failed for sandbox ${row.externalId}:`,
          reason,
        );
      }
    });
    report.synced = report.results.filter((result) => result.status === 'synced').length;
    report.failed = report.results.filter((result) => result.status === 'failed').length;
    report.exported = report.results.reduce((sum, result) => sum + result.exported, 0);
    report.results.sort((a, b) => a.session_id.localeCompare(b.session_id));
    report.ok = report.failed === 0;
    console.info('[env-sync] propagate: complete', {
      projectId,
      activeSandboxes: report.active_sandboxes,
      targeted: report.targeted,
      synced: report.synced,
      failed: report.failed,
      exported: report.exported,
    });
    return report;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[env-sync] hot fan-out failed for project ${projectId}:`,
      reason,
    );
    report.ok = false;
    report.failed += 1;
    report.results.push({
      session_id: '',
      sandbox_id: null,
      status: 'failed',
      scope: null,
      revision: null,
      exported: 0,
      managed: null,
      withheld: null,
      agent_env_written: false,
      reason,
    });
    return report;
  }
}

export function emptySandboxEnvSnapshot(reason: string): SandboxEnvSnapshot {
  return {
    env: {},
    names: [],
    revision: `${reason}-${Date.now()}`,
    scope: 'inherit',
    capabilitiesJson: '{"version":1,"capabilities":[]}',
  };
}

export async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Re-point ONE live session at a different model.
 *
 * opencode reads `KORTIX_OPENCODE_MODEL` when it builds its config at spawn, so
 * the value must reach the daemon AND opencode must restart for it to take
 * effect. `refreshModels: true` is what triggers that restart.
 *
 * Best-effort by design: the row is already updated by the caller, so a sandbox
 * that is down or unreachable simply picks the new model up on its next boot.
 * Returns whether a live box actually took it, so the caller can tell the user
 * whether the change is in effect NOW or only from the next turn.
 */
/**
 * Recompile this session's agent config from git and deliver it to the running box.
 *
 * The compiled agent config — agents, their prompts, permissions, model — is the
 * one part of a session's configuration with no runtime source. It is compiled
 * once at provision and handed down as `KORTIX_COMPILED_AGENT_CONFIG`, so a
 * session merged past days ago keeps running the agents it booted with. Pulling
 * the branch inside the sandbox does not help (the compiled bytes never came
 * from the working tree) and neither did restarting opencode (the daemon's env
 * was unchanged, so a respawn rebuilt the same config).
 *
 * Recompiles from `baseRef` — the ref the SESSION runs on, which is not always
 * the project default.
 *
 * Costs an opencode restart, because opencode reads its config only at spawn.
 * Callers that are already restarting the box pay nothing extra; a caller doing
 * this mid-session is interrupting a turn and must say so.
 */
export async function pushSessionAgentConfigToSandbox(input: {
  projectId: string;
  sessionId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath?: string | null;
  baseRef?: string | null;
  /** Reports real operation boundaries to callers that expose progress. */
  onPhase?: (phase: 'compiling-config' | 'applying-config') => void;
}): Promise<{
  applied: boolean;
  reason?: string;
  opencodeReload?: 'disposed' | 'restarted' | 'kept-old' | null;
  opencodeTurnEnded?: boolean | null;
}> {
  try {
    input.onPhase?.('compiling-config');
    const [session] = await db
      .select({
        agentName: projectSessions.agentName,
        metadata: projectSessions.metadata,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, input.sessionId))
      .limit(1);
    const gitProject = {
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    };
    const compiled =
      !workspaceModeAllowsFullRepository(workspaceModeFromSessionMetadata(session?.metadata)) &&
      session?.agentName
        ? await resolveSelectedAgentConfigForSession(
            gitProject,
            session.agentName,
            input.baseRef,
          )
        : await resolveCompiledAgentConfigForSession(gitProject, input.baseRef);
    // `null` is a v1 project or an unreadable manifest. Pushing an empty value
    // would DELETE the agent config the box is running — a v1 project has none
    // to begin with, and for a transient read failure that would be a silent
    // downgrade to no agents at all. Leave the box as it is.
    if (!compiled) return { applied: false, reason: 'no compiled agent config' };

    const [row] = await db
      .select({ externalId: sessionSandboxes.externalId, config: sessionSandboxes.config })
      .from(sessionSandboxes)
      .where(
        and(eq(sessionSandboxes.sessionId, input.sessionId), eq(sessionSandboxes.status, 'active')),
      )
      .limit(1);
    if (!row?.externalId) return { applied: false, reason: 'no active sandbox' };

    const config = (row.config || {}) as Record<string, unknown>;
    const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
    if (!serviceKey) return { applied: false, reason: 'sandbox has no service key' };

    const snapshot = await resolveSandboxEnvSnapshot(input.projectId, input.sessionId);
    if (!snapshot) return { applied: false, reason: 'no env snapshot' };

    const { url, headers } = await resolveSandboxIngress(row.externalId, {
      port: SANDBOX_SERVICE_PORT,
      transport: 'http',
    });
    // The daemon call blocks until its verified reload either promotes the new
    // runtime or keeps the old one. This phase therefore names the whole
    // apply-and-validate boundary instead of inventing sub-phases we cannot see.
    input.onPhase?.('applying-config');
    const pushed = await postEnvToDaemon({
      previewUrl: url,
      providerHeaders: headers,
      serviceKey,
      snapshot,
      opencodeEnv: {
        KORTIX_COMPILED_AGENT_CONFIG: compiled,
        // Pushed with the config so the box's reported etag never lags what it
        // is actually running.
        KORTIX_COMPILED_AGENT_CONFIG_ETAG: agentConfigEtag(compiled) ?? '',
      },
      // Restarts opencode so it rebuilds its config against the new agents.
      refreshModels: true,
    });
    // `applied` means WE pushed it. Whether opencode actually took it is
    // `opencodeReload` — a declined swap leaves the old config running, and
    // reporting a bare `applied: true` for that is the lie this field prevents.
    return {
      applied: true,
      opencodeReload: pushed.opencodeReload,
      opencodeTurnEnded: pushed.opencodeTurnEnded,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[env-sync] agent-config push failed for session ${input.sessionId}:`, reason);
    return { applied: false, reason };
  }
}

export async function pushSessionModelToSandbox(input: {
  projectId: string;
  sessionId: string;
  model: string;
}): Promise<{ applied: boolean; reason?: string }> {
  try {
    const [row] = await db
      .select({
        externalId: sessionSandboxes.externalId,
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sessionId, input.sessionId),
          eq(sessionSandboxes.status, 'active'),
        ),
      )
      .limit(1);
    if (!row?.externalId) return { applied: false, reason: 'no active sandbox' };

    const config = (row.config || {}) as Record<string, unknown>;
    const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
    if (!serviceKey) return { applied: false, reason: 'sandbox has no service key' };

    const snapshot = await resolveSandboxEnvSnapshot(input.projectId, input.sessionId);
    if (!snapshot) return { applied: false, reason: 'no env snapshot' };

    const { url, headers } = await resolveSandboxIngress(row.externalId, {
      port: SANDBOX_SERVICE_PORT,
      transport: 'http',
    });
    await postEnvToDaemon({
      previewUrl: url,
      providerHeaders: headers,
      serviceKey,
      snapshot,
      opencodeEnv: { KORTIX_OPENCODE_MODEL: input.model },
      // Restarts opencode so it rebuilds its config against the new model.
      refreshModels: true,
    });
    return { applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[env-sync] model push failed for session ${input.sessionId}:`, reason);
    return { applied: false, reason };
  }
}

/**
 * Re-resolve this session's secrets snapshot and deliver it to the RUNNING
 * sandbox, restarting opencode so its process env picks up the new set.
 *
 * `PUT /sessions/{id}/scope` re-scopes a live session's secrets allowlist. The
 * row was persisted, but for a long time nothing pushed the new snapshot to the
 * box: the route returned "Applies from the next prompt." and delegated the
 * actual delivery to `syncSandboxEnvForPrompt`. That delegation was unreliable:
 *
 *   - the per-prompt hot sync has two silent early-returns (`!serviceKey`,
 *     `!snapshot`/`!row.createdBy`) that skip the POST with no log;
 *   - it only fires when the prompt routes through `POST :8000
 *     /session/{id}/{prompt_async|message}` — a prompt sent any other way
 *     (straight to :4096, the lifecycle queue) slips past it;
 *   - even when it DID fire, the daemon's env route took the ~51ms dispose
 *     fast path for a pure secret change, and a dispose re-reads the opencode
 *     CONFIG file only — it does not re-run `mergeProjectEnv`, so opencode's
 *     process env stayed on the OLD (0/47) snapshot while `agent-env.sh` got
 *     the new one (so freshly-started shells saw 47/47). The box reported a
 *     stale OpenCode PID until something else forced a respawn.
 *
 * Pushing here — the same pattern the `/model` PUT already uses — fixes both
 * halves: the snapshot is re-derived from the freshly-committed allowlist and
 * POSTed to the daemon, and `refreshModels: true` restarts opencode so
 * `spawnChild` re-runs `mergeProjectEnv`. The LLM-gateway mode + base URL are
 * re-stamped alongside (same channel), and revocation
 * keeps working (`knownNames` is still tracked in the daemon store, so a
 * dropped secret is actively cleared on the respawn).
 *
 * Best-effort by design, mirroring `pushSessionModelToSandbox`: the row is
 * already committed, so a sandbox that is down or unreachable simply picks the
 * new scope up on its next boot. The caller reports `applied_live` so a UI can
 * tell "in effect now" from "stored, applies at next boot" — the same
 * distinction the model route makes.
 */
export async function pushSessionScopeToSandbox(input: {
  projectId: string;
  sessionId: string;
}): Promise<{ applied: boolean; reason?: string }> {
  try {
    const [row] = await db
      .select({
        externalId: sessionSandboxes.externalId,
        provider: sessionSandboxes.provider,
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sessionId, input.sessionId),
          eq(sessionSandboxes.status, 'active'),
        ),
      )
      .limit(1);
    if (!row?.externalId) return { applied: false, reason: 'no active sandbox' };

    const config = (row.config || {}) as Record<string, unknown>;
    const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
    if (!serviceKey) return { applied: false, reason: 'sandbox has no service key' };

    // Re-derive from the row the route JUST committed — `resolveOwnerRawEnv`
    // reads `secretsAllowlist` fresh, so this reflects the new scope, not the
    // boot snapshot the daemon is still running.
    const snapshot = await resolveSandboxEnvSnapshot(input.projectId, input.sessionId);
    if (!snapshot) return { applied: false, reason: 'no env snapshot' };

    const { url, headers } = await resolveSandboxIngress(row.externalId, {
      port: SANDBOX_SERVICE_PORT,
      transport: 'http',
    });
    await postEnvToDaemon({
      previewUrl: url,
      providerHeaders: headers,
      serviceKey,
      snapshot,
      // Restarts opencode so spawnChild re-runs mergeProjectEnv + the gateway
      // strip. A dispose cannot refresh the child's process env (project
      // secrets shape it at spawn, not via the config file), so the respawn is
      // the load-bearing part — see the daemon-side gate in routes/env.ts.
      refreshModels: true,
      // Gateway mode is the only mode: re-stamp it with the snapshot so the
      // respin cannot drop the gateway routing (see the per-prompt path).
      llmGatewayEnabled: true,
      llmGatewayBaseUrl: llmGatewayBaseUrlForProvider(row.provider as ProviderName),
    });
    return { applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[env-sync] scope push failed for session ${input.sessionId}:`, reason);
    return { applied: false, reason };
  }
}
