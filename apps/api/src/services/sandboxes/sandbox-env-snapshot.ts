import { createHash } from 'node:crypto';
import type { ProviderName } from '../platform/providers';
import {
  intersectSecretGrants,
  listProjectSecretsSnapshotForUser,
  projectSecretsRevision,
} from '../secrets/secrets';
import { sanitizeSandboxEnv } from './sandbox-env-names';
import { loadSessionSecretContext, type SessionSecretContext } from '../sessions/session-secret-context';
import type { NetworkBoundarySecretBinding } from '../secrets/network-boundary';

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
export const PROMPT_BOUNDARY_ARM_WAIT_MS = 1_500;

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
export const armedNetworkBoundaries = new Map<string, BoundaryArmRecord>();
/** In-flight arms, so two prompts on one sandbox never race two PUTs at the
 *  provider. Same digest joins; a different digest queues behind it. */
const inFlightNetworkBoundaries = new Map<string, { digest: string; done: Promise<void> }>();

/** Test seam: drop every remembered arm so a case starts from a cold replica. */
export function __resetNetworkBoundaryArmCacheForTests(): void {
  armedNetworkBoundaries.clear();
  inFlightNetworkBoundaries.clear();
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
 * every provider: the guest holds a HANDLE, the broker route substitutes the real value
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
export async function syncProviderNetworkBoundary(
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

async function resolveOwnerRawEnv(
  projectId: string,
  sessionId: string | null,
  requestedAgent?: string | null,
  /** The session's secret context, when the caller already started the read. */
  context?: Promise<SessionSecretContext>,
): Promise<{
  env: Record<string, string>;
  capabilitiesJson: string;
  scope: SandboxEnvSnapshot['scope'];
} | null> {
  if (!sessionId) return null;
  const { session: row, grantEnv: resolveGrantEnv, personalUserId: personalOwner } = await (context ??
    loadSessionSecretContext(projectId, sessionId, requestedAgent));
  if (!row?.createdBy) return null;

  // The owner read needs nothing from the grant: it starts beside it.
  const ownerRead = personalOwner();
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
  const grantEnv = await resolveGrantEnv();

  // THE CLOBBER FIX: apply the SAME per-session secrets narrowing as boot
  // (buildSessionSandboxEnvVars). Without this, the first prompt's env sync (and
  // every secret-CRUD fan-out) would re-push the full agent-grant set into a
  // narrowed sandbox, silently widening it back. null allowlist → passthrough.
  const grantEnvForSession = intersectSecretGrants(grantEnv, row.secretsAllowlist ?? null);
  // Spec 2026-09-22 §2.3: the personal-override owner is the session's
  // on-behalf-of human in a private session under the agent-principal model
  // (null after a foreign prompt clears it); the creator otherwise (legacy).
  const personalUserId = await ownerRead;
  const snapshot = await listProjectSecretsSnapshotForUser(
    projectId,
    personalUserId,
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
  context?: Promise<SessionSecretContext>,
): Promise<SandboxEnvSnapshot | null> {
  const resolved = await resolveOwnerRawEnv(projectId, sessionId, requestedAgent, context);
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
