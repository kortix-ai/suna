/**
 * `CredentialStatus`/`CredentialRecord` — docs/specs/2026-07-22-unified-
 * auth-gateway.md §4. A READ-SIDE projection over the exact same
 * `project_secrets` rows `resolution/harness-models.ts` already reads via
 * `env: Record<string,string>` — no new storage, no duplicated logic: this
 * module delegates to the already-shipped `credentials/codex.ts` resolver
 * and the new `credentials/claude.ts`/`credentials/api-key.ts` modules
 * (Step 2) rather than re-deriving credential health itself.
 *
 * NOT wired into `resolveHarnessModels` — that function stays untouched
 * (spec §5.1/§10.2, and this task's brief explicitly scopes "resolver
 * wiring" to the next wave, Step 3+). This is a SEPARATE read path for
 * UI/CLI display, exactly as §4 specifies.
 *
 * ── Deviation from the spec's literal 3-argument signature ──
 * §4 writes `resolveCredentialStatus(projectId, userId, providerId)`. This
 * registry's natural key is `(id, door)` — Step 0 gave Anthropic and OpenAI
 * TWO rows each (an 'account' door and an 'api-key' door sharing one
 * catalog `id`, per `auth/registry.ts`'s own entries and the §9.1 wireframe
 * showing "Claude Code" and "Anthropic" as separate rows for the same
 * company). A 3-arg signature can't disambiguate which of the two a caller
 * means, so `door` is a required 4th parameter here. Flagged for the next
 * wave (routes) to confirm before building `GET /auth-providers` on top of
 * this.
 */
import { getProjectSecretValue } from '../../projects/secrets';
import { checkApiKeyLiveness } from '../credentials/api-key';
import { probeClaudeConnection, resolveClaudeCredential } from '../credentials/claude';
import { CodexRefreshError, resolveCodexCredential } from '../credentials/codex';
import { type AuthDoor, type AuthProviderDescriptor, findAuthProvider } from './registry';

export type CredentialStatus = 'healthy' | 'expired' | 'invalid' | 'unverified' | 'absent';

export interface CredentialRecord {
  providerId: string;
  authKind: import('@kortix/shared/harnesses').HarnessAuthKind;
  door: AuthDoor;
  scope: 'shared' | 'personal';
  status: CredentialStatus;
  refreshable: boolean;
  expiresAt: number | null;
  /** `null` whenever `status` is `'absent'` or `'unverified'` — a
   *  conclusive live check (healthy/invalid/expired) is the only thing that
   *  sets this, per the spec's own field doc ("null for 'unverified'"). */
  lastCheckedAt: number | null;
  reason: string | null;
}

export class UnknownAuthProviderError extends Error {
  constructor(
    readonly providerId: string,
    readonly door: AuthDoor,
  ) {
    super(`no auth-provider registry entry for id "${providerId}" door "${door}"`);
    this.name = 'UnknownAuthProviderError';
  }
}

/** Injection points for testability — mirrors `resolveHarnessModels`'s
 *  `resolveCodex`/`probeManagedModelServable` pattern; defaults to the
 *  real, DB-backed implementations. */
export interface ResolveCredentialStatusDeps {
  resolveCodex?: typeof resolveCodexCredential;
  resolveClaude?: typeof resolveClaudeCredential;
  probeClaude?: typeof probeClaudeConnection;
  checkApiKey?: typeof checkApiKeyLiveness;
  getSecretValue?: typeof getProjectSecretValue;
}

function checkedAt(status: CredentialStatus): number | null {
  return status === 'unverified' || status === 'absent' ? null : Date.now();
}

function record(
  entry: AuthProviderDescriptor,
  input: {
    status: CredentialStatus;
    scope?: 'shared' | 'personal';
    expiresAt?: number | null;
    reason?: string | null;
  },
): CredentialRecord {
  return {
    providerId: entry.id,
    authKind: entry.producesAuthKind,
    door: entry.door,
    scope: input.scope ?? 'shared',
    status: input.status,
    refreshable: entry.refresh === 'refresh-token',
    expiresAt: input.expiresAt ?? null,
    lastCheckedAt: checkedAt(input.status),
    reason: input.reason ?? null,
  };
}

async function resolveCodexStatus(
  entry: AuthProviderDescriptor,
  projectId: string,
  userId: string | null,
  resolveCodex: typeof resolveCodexCredential,
): Promise<CredentialRecord> {
  try {
    const credential = await resolveCodex(projectId, userId ?? '');
    if (!credential) {
      return record(entry, { status: 'absent', reason: `Connect ${entry.label} to use this credential.` });
    }
    // resolveCodexCredential already refreshes-on-read (single-flight) and
    // throws CodexRefreshError when the token is genuinely dead — reaching
    // here with a credential means it's currently usable.
    return record(entry, { status: 'healthy', expiresAt: credential.expiresAt ?? null });
  } catch (err) {
    if (err instanceof CodexRefreshError) {
      return record(entry, { status: 'expired', reason: err.message });
    }
    throw err;
  }
}

async function resolveClaudeStatus(
  entry: AuthProviderDescriptor,
  projectId: string,
  userId: string | null,
  resolveClaude: typeof resolveClaudeCredential,
  probeClaude: typeof probeClaudeConnection,
): Promise<CredentialRecord> {
  const stored = await resolveClaude(projectId, userId ?? '');
  if (!stored) {
    return record(entry, { status: 'absent', reason: `Connect ${entry.label} to use this credential.` });
  }
  if (stored.expiresAt !== null && Date.now() >= stored.expiresAt) {
    return record(entry, {
      status: 'expired',
      scope: stored.scope,
      expiresAt: stored.expiresAt,
      reason: 'Your Claude subscription token has expired — reconnect in project settings.',
    });
  }
  const probeStatus = await probeClaude(stored.token);
  return record(entry, {
    status: probeStatus,
    scope: stored.scope,
    expiresAt: stored.expiresAt,
    reason: probeStatus === 'invalid' ? `${entry.label} was rejected by Anthropic — reconnect.` : null,
  });
}

/**
 * `anthropic_api_key`/`openai_api_key`/`openai_compatible`/
 * `anthropic_compatible` — every remaining `producesAuthKind`. Presence via
 * the SHARED project secret (`getProjectSecretValue`, `owner_user_id IS
 * NULL` — every existing api-key connection in this codebase is
 * project-wide, never a personal override the way Codex's OAuth login is),
 * liveness via `checkApiKeyLiveness` when a probe is registered for
 * `entry.id`, else the honest `'unverified'` default.
 */
async function resolveApiKeyStatus(
  entry: AuthProviderDescriptor,
  projectId: string,
  getSecretValue: typeof getProjectSecretValue,
  checkApiKey: typeof checkApiKeyLiveness,
): Promise<CredentialRecord> {
  const envVars = entry.apiKeyEnvVars ?? [];
  let value: string | null = null;
  for (const name of envVars) {
    const candidate = await getSecretValue(projectId, name);
    if (candidate?.trim()) {
      value = candidate;
      break;
    }
  }
  if (!value) {
    return record(entry, { status: 'absent', reason: `Connect ${entry.label} to use this credential.` });
  }
  const status = await checkApiKey(entry.id, value);
  return record(entry, {
    status,
    reason:
      status === 'invalid'
        ? `${entry.label} was rejected by the upstream provider — check the key and reconnect.`
        : null,
  });
}

/**
 * THE single computation of "is this stored connection currently usable" —
 * every UI/CLI surface should read this instead of hand-deriving
 * "Connected"/"Needs attention" from raw env presence.
 */
export async function resolveCredentialStatus(
  projectId: string,
  userId: string | null,
  providerId: string,
  door: AuthDoor,
  deps: ResolveCredentialStatusDeps = {},
): Promise<CredentialRecord> {
  const entry = findAuthProvider(providerId, door);
  if (!entry) throw new UnknownAuthProviderError(providerId, door);

  const resolveCodex = deps.resolveCodex ?? resolveCodexCredential;
  const resolveClaude = deps.resolveClaude ?? resolveClaudeCredential;
  const probeClaude = deps.probeClaude ?? probeClaudeConnection;
  const checkApiKey = deps.checkApiKey ?? checkApiKeyLiveness;
  const getSecretValue = deps.getSecretValue ?? getProjectSecretValue;

  switch (entry.producesAuthKind) {
    case 'codex_subscription':
      return resolveCodexStatus(entry, projectId, userId, resolveCodex);
    case 'claude_subscription':
      return resolveClaudeStatus(entry, projectId, userId, resolveClaude, probeClaude);
    case 'anthropic_api_key':
    case 'openai_api_key':
    case 'openai_compatible':
    case 'anthropic_compatible':
      return resolveApiKeyStatus(entry, projectId, getSecretValue, checkApiKey);
    case 'managed_gateway':
    case 'native_config':
      // Neither ever gets a registry row (auth/registry.ts's doc comment) —
      // unreachable by construction, kept as an explicit throw (fail-closed)
      // rather than a silent fallthrough in case that invariant ever slips.
      throw new UnknownAuthProviderError(providerId, door);
  }
}
