import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { SESSION_SECRETS_ALLOWLIST_MAX_KEYS } from '@kortix/api-contract';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { projectSecrets, projectSessionSecretHandles, projectSessions, projects } from '@kortix/db';
import { config } from '../config';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import {
  type SecretEgressPolicy,
  type SecretConsumer,
  type SecretStrategy,
  emitsValue,
  mintHandle,
  newLookupId,
  resolveSecretDelivery,
} from '../secrets/strategy';
import {
  buildSecretCapabilities,
  serializeSecretCapabilities,
  type SecretCapabilityCatalog,
} from './secret-capabilities';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;
const IDENTIFIER_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENVELOPE_VERSION = 'v1';
const GCM_AUTH_TAG_LENGTH = 16;

function b64url(input: Buffer): string {
  return input.toString('base64url');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_REGEX.test(name);
}

/** A secret's `identifier` — the unique-per-project handle agents grant + the
 *  UI shows. More permissive than the env-var-shaped `name` (KEY): letters,
 *  digits, `_`, `.`, `-`, starting with an alphanumeric, max 128 chars. */
export function isValidIdentifier(identifier: string): boolean {
  return IDENTIFIER_REGEX.test(identifier);
}

/**
 * True if writing `newKey` under an identifier that ALREADY exists with a
 * DIFFERENT key (`existingKey`) would silently retarget it — an identifier is
 * a stable handle (agents grant it, the DB uniquely keys on it), so redefining
 * its underlying env-var KEY via upsert is rejected rather than allowed as a
 * surprising in-place swap. `existingKey === null` means no row exists yet
 * (never a conflict — this is the create path).
 */
export function identifierKeyConflicts(existingKey: string | null, newKey: string): boolean {
  return existingKey !== null && existingKey !== newKey;
}

function projectSecretKey(projectId: string): Buffer {
  if (!config.API_KEY_SECRET) {
    throw new Error('API_KEY_SECRET not configured; cannot encrypt project secrets');
  }
  const key = hkdfSync(
    'sha256',
    Buffer.from(config.API_KEY_SECRET, 'utf8'),
    Buffer.from(projectId, 'utf8'),
    Buffer.from('kortix-project-secret-v1', 'utf8'),
    32,
  );
  return Buffer.from(key);
}

export function encryptProjectSecret(projectId: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', projectSecretKey(projectId), iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_VERSION}:${b64url(iv)}:${b64url(tag)}:${b64url(ciphertext)}`;
}

export function decryptProjectSecret(projectId: string, valueEnc: string): string {
  const [version, ivB64, tagB64, ciphertextB64] = valueEnc.split(':');
  if (
    version !== ENVELOPE_VERSION ||
    !ivB64 ||
    !tagB64 ||
    ciphertextB64 === undefined
  ) {
    throw new Error('Unsupported project secret envelope');
  }
  const tag = fromB64url(tagB64);
  if (tag.length !== GCM_AUTH_TAG_LENGTH) {
    throw new Error('Unsupported project secret auth tag length');
  }
  const decipher = createDecipheriv('aes-256-gcm', projectSecretKey(projectId), fromB64url(ivB64), {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(fromB64url(ciphertextB64)), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Upsert the SHARED (owner_user_id IS NULL) row for a project secret to a new
 * value, keyed by IDENTIFIER (defaults to the KEY when omitted — the migrated/
 * simple case). Mirrors the POST /secrets handler's insert/onConflict, factored
 * out so the public setup-link intake endpoint (no authenticated user) can write
 * the value a human supplied via a minted link. `scope` is only set on first
 * insert — an existing connector-scoped row keeps its scope on re-submit.
 */
export async function writeSharedProjectSecret(input: {
  projectId: string;
  name: string;
  identifier?: string;
  value: string;
  scope?: 'runtime' | 'connector';
  createdBy?: string | null;
}): Promise<void> {
  const now = new Date();
  const identifier = input.identifier ?? input.name;
  await db
    .insert(projectSecrets)
    .values({
      projectId: input.projectId,
      identifier,
      name: input.name,
      valueEnc: encryptProjectSecret(input.projectId, input.value),
      scope: input.scope ?? 'runtime',
      createdBy: input.createdBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectSecrets.projectId, projectSecrets.identifier],
      targetWhere: isNull(projectSecrets.ownerUserId),
      set: {
        name: input.name,
        valueEnc: encryptProjectSecret(input.projectId, input.value),
        updatedAt: now,
      },
    });
}

/**
 * Decrypted KEY->value map of the project's SHARED runtime secrets
 * (owner_user_id IS NULL). Platform-reserved KORTIX_* rows are excluded so
 * legacy system secrets can never leak into the sandbox as user-controlled env
 * vars. Since a KEY is no longer unique (multiple identifiers may share one),
 * ties are broken deterministically: the row whose identifier equals the key
 * wins (the common/migrated case), else the most-recently-updated row. This is
 * the general project-scoped view used by non-sandbox callers (e.g. Slack
 * install lookup, the LLM-gateway provider picker); sandbox boot uses
 * `listProjectSecretsSnapshotForUser` so the running agent's `secrets` grant
 * (by identifier) is honored.
 */
export async function listProjectSecrets(projectId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({
      identifier: projectSecrets.identifier,
      name: projectSecrets.name,
      valueEnc: projectSecrets.valueEnc,
      scope: projectSecrets.scope,
      updatedAt: projectSecrets.updatedAt,
    })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), isNull(projectSecrets.ownerUserId)))
    .orderBy(desc(projectSecrets.updatedAt));

  const env: Record<string, string> = {};
  const winnerIsCanonical = new Set<string>();
  for (const row of rows) {
    if (row.name.toUpperCase().startsWith('KORTIX_')) continue;
    // Connector credentials / Pipedream bindings are resolved server-side by the
    // Connector gateway — never injected into the sandbox env.
    if (row.scope === 'connector') continue;
    const canonical = row.identifier === row.name;
    if (row.name in env && winnerIsCanonical.has(row.name) && !canonical) continue;
    env[row.name] = decryptProjectSecret(projectId, row.valueEnc);
    if (canonical) winnerIsCanonical.add(row.name);
  }
  return env;
}

/**
 * One project secret resolved for a specific launching user: the shared
 * (project-wide) row, shadowed by that user's own ACTIVE personal override of
 * the SAME identifier if one exists (used today only by the CODEX_AUTH_JSON
 * per-user provider login — see project_secrets.ownerUserId doc comment).
 */
export interface ResolvedProjectSecret {
  /** Shared policy row id. Handles always reference this row. */
  secretId: string;
  identifier: string;
  key: string;
  value: string;
  /** Delivery strategy for this row. Absent on rows resolved before the column
   *  existed; `resolveSecretDelivery` reads absence as "no opinion", NOT as
   *  `runtime`, so an older row cannot silently downgrade a narrowed one. */
  strategy?: SecretStrategy;
  /** The only service allowed to receive plaintext. */
  consumer?: SecretConsumer | null;
  egressPolicy?: SecretEgressPolicy | null;
  handlePrefix?: string | null;
}

/**
 * Every runtime-scope project secret, resolved AS a specific user (their own
 * active override wins per identifier), grouped by IDENTIFIER — the unit an
 * agent's `secrets` grant addresses. KORTIX_* (reserved) and connector-scoped
 * rows are never included. `userId` may be null for contexts with no acting
 * human (e.g. a webhook-triggered session) — only shared rows apply then.
 */
export async function listResolvedProjectSecrets(
  projectId: string,
  userId: string | null,
): Promise<ResolvedProjectSecret[]> {
  const rows = await db
    .select({
      secretId: projectSecrets.secretId,
      identifier: projectSecrets.identifier,
      name: projectSecrets.name,
      valueEnc: projectSecrets.valueEnc,
      scope: projectSecrets.scope,
      ownerUserId: projectSecrets.ownerUserId,
      active: projectSecrets.active,
      strategy: projectSecrets.strategy,
      consumer: projectSecrets.consumer,
      egressPolicy: projectSecrets.egressPolicy,
      handlePrefix: projectSecrets.handlePrefix,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.scope, 'runtime'),
        userId
          ? or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, userId))
          : isNull(projectSecrets.ownerUserId),
      ),
    );

  type Row = (typeof rows)[number];
  const byIdentifier = new Map<string, { shared?: Row; personal?: Row }>();
  for (const row of rows) {
    if (row.name.toUpperCase().startsWith('KORTIX_')) continue;
    const slot = byIdentifier.get(row.identifier) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else slot.personal = row;
    byIdentifier.set(row.identifier, slot);
  }

  const out: ResolvedProjectSecret[] = [];
  for (const [identifier, slot] of byIdentifier) {
    const chosen = slot.personal && slot.personal.active ? slot.personal : slot.shared;
    if (!chosen) continue;
    const policyRow = slot.shared ?? chosen;
    out.push({
      secretId: policyRow.secretId,
      identifier,
      key: chosen.name,
      value: decryptProjectSecret(projectId, chosen.valueEnc),
      strategy: policyRow.strategy ?? undefined,
      consumer: policyRow.consumer ?? undefined,
      egressPolicy: policyRow.egressPolicy ?? null,
      handlePrefix: policyRow.handlePrefix ?? null,
    });
  }
  return out;
}

/**
 * Thrown when an agent's EXPLICIT `secrets` grant (a concrete identifier list,
 * not `'all'`) names two-or-more identifiers that resolve to the SAME env var
 * KEY — there's no principled way to pick a winner for a deliberate selection,
 * so this is a configuration error the caller must surface, not silently
 * resolve. An `'all'` grant never throws (see resolveGrantedSecretEnv).
 */
export class AmbiguousSecretGrantError extends Error {
  constructor(
    public readonly key: string,
    public readonly identifiers: string[],
  ) {
    super(
      `secrets grant is ambiguous: key "${key}" is provided by multiple granted identifiers (${identifiers.join(', ')})`,
    );
    this.name = 'AmbiguousSecretGrantError';
  }
}

/**
 * The whole security decision for injecting secrets into an agent's sandbox
 * env: given every secret resolved for the launching user (by identifier) and
 * the running agent's `secrets` grant, which identifiers are allowed and what
 * KEY=value env results. Pure — DB-free, fully unit-testable.
 *
 *   grant === undefined | 'all' → every identifier is allowed. If two allowed
 *     identifiers share a KEY (e.g. GMAPS-primary / GMAPS-backup both
 *     GOOGLE_MAPS_API_KEY), a deterministic winner is picked (identifier sort
 *     order) rather than erroring — 'all' is a default, not a deliberate
 *     per-identifier choice.
 *   grant === string[] (explicit list, case-insensitive match on identifier)
 *     → only those identifiers are allowed. Two ALLOWED identifiers sharing a
 *     KEY is an AmbiguousSecretGrantError — a deliberate list naming both is a
 *     misconfiguration, not something to silently resolve.
 */
function resolveGrantedSecretSelection(
  rows: ResolvedProjectSecret[],
  grant: string[] | 'all' | undefined,
): {
  env: Record<string, string>;
  identifiers: string[];
  selected: ResolvedProjectSecret[];
} {
  const allowAll = grant === undefined || grant === 'all';
  const allowSet = allowAll ? null : new Set(grant.map((g) => g.toUpperCase()));
  const allowed = allowAll ? rows : rows.filter((r) => allowSet!.has(r.identifier.toUpperCase()));

  const byKey = new Map<string, ResolvedProjectSecret[]>();
  for (const row of allowed) {
    const list = byKey.get(row.key) ?? [];
    list.push(row);
    byKey.set(row.key, list);
  }

  const env: Record<string, string> = {};
  const selected: ResolvedProjectSecret[] = [];
  for (const [key, candidates] of byKey) {
    if (candidates.length === 1) {
      env[key] = candidates[0]!.value;
      selected.push(candidates[0]!);
      continue;
    }
    if (!allowAll) {
      throw new AmbiguousSecretGrantError(key, candidates.map((c) => c.identifier).sort());
    }
    const winner = [...candidates].sort((a, b) => a.identifier.localeCompare(b.identifier))[0]!;
    env[key] = winner.value;
    selected.push(winner);
  }

  return { env, identifiers: allowed.map((r) => r.identifier), selected };
}

export function resolveGrantedSecretEnv(
  rows: ResolvedProjectSecret[],
  grant: string[] | 'all' | undefined,
): { env: Record<string, string>; identifiers: string[] } {
  const { env, identifiers } = resolveGrantedSecretSelection(rows, grant);
  return { env, identifiers };
}

// Single source of truth in @kortix/api-contract (route-contract validation);
// re-exported here so internal callers keep the same import site.
export { SESSION_SECRETS_ALLOWLIST_MAX_KEYS };

/**
 * Shape-validate a session-create body's `secrets` field (the per-session
 * allowlist). Pure — no DB. `undefined` (absent) → { ok, value: undefined };
 * anything present must be an array of ≤128 valid secret identifiers. Mirrors
 * parseSessionConnectorBindings so every createProjectSession caller (incl. the
 * internal ones that bypass the api-contract) gets the same guardrail.
 */
export function parseSessionSecretsAllowlist(
  raw: unknown,
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: 'secrets must be an array of identifiers' };
  if (raw.length > SESSION_SECRETS_ALLOWLIST_MAX_KEYS) {
    return {
      ok: false,
      error: `secrets may contain at most ${SESSION_SECRETS_ALLOWLIST_MAX_KEYS} identifiers`,
    };
  }
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isValidIdentifier(entry)) {
      return {
        ok: false,
        error: `invalid secret identifier: ${String(entry)}`,
      };
    }
  }
  return { ok: true, value: raw as string[] };
}

/**
 * Narrow an agent's secret grant by a per-session allowlist (dosco-as-a-Backend).
 * The result is ALWAYS a subset of what `grant` alone would allow — this is a
 * pure NARROWING, never a widening, so it can be composed with the existing
 * agent-grant/reserved-name/connector-scope filters without weakening any of
 * them. Pure — DB-free, fully unit-testable.
 *
 *   allowlist == null | undefined → return `grant` unchanged (no session
 *     restriction; byte-identical to the pre-KaaB path).
 *   grant == undefined | 'all'    → return `allowlist` (the session list
 *     becomes the explicit grant — narrowing from "every secret" to the named
 *     set). `[]` therefore means inject ZERO project secrets.
 *   both lists                    → case-insensitive intersection (only
 *     identifiers named in BOTH survive).
 */
export function intersectSecretGrants(
  grant: string[] | 'all' | undefined,
  allowlist: string[] | null | undefined,
): string[] | 'all' | undefined {
  if (allowlist === null || allowlist === undefined) return grant;
  if (grant === undefined || grant === 'all') return allowlist;
  const grantUpper = new Set(grant.map((g) => g.toUpperCase()));
  return allowlist.filter((id) => grantUpper.has(id.toUpperCase()));
}

/**
 * Detect an env-KEY collision AMONG the allowlisted identifiers, using rows
 * already resolved for the project. Two distinct identifiers naming the same
 * env KEY (e.g. GMAPS_PRIMARY / GMAPS_BACKUP → GOOGLE_MAPS_API_KEY) are a valid
 * project config, but naming BOTH in one session allowlist makes the boot-time
 * resolver throw AmbiguousSecretGrantError — and because the allowlist is
 * immutable, that permanently bricks the session. Surfacing it here lets create
 * reject with a clean 409 the caller can fix. Conservative: ignores the agent
 * grant (which could have dropped one), so it may reject a shade more than the
 * boot resolver strictly would — deterministic, cheap, and fail-closed. Pure.
 * Returns the first colliding { key, identifiers } (identifiers sorted) or null.
 */
export function secretKeyCollisionInAllowlist(
  rows: ResolvedProjectSecret[],
  allowlist: string[],
): { key: string; identifiers: string[] } | null {
  const allowUpper = new Set(allowlist.map((id) => id.toUpperCase()));
  const byKey = new Map<string, string[]>();
  for (const row of rows) {
    if (!allowUpper.has(row.identifier.toUpperCase())) continue;
    const ids = byKey.get(row.key) ?? [];
    ids.push(row.identifier);
    byKey.set(row.key, ids);
  }
  for (const [key, identifiers] of byKey) {
    if (identifiers.length > 1) return { key, identifiers: [...identifiers].sort() };
  }
  return null;
}

/**
 * Canonical form of a secrets allowlist for idempotency-conflict comparison:
 * upper-cased (identifier matching is case-insensitive), de-duplicated, sorted.
 * null/undefined → null (absence is distinct from an empty list).
 */
export function canonicalizeSecretsAllowlist(
  allowlist: string[] | null | undefined,
): string[] | null {
  if (allowlist === null || allowlist === undefined) return null;
  return [...new Set(allowlist.map((id) => id.toUpperCase()))].sort();
}

/**
 * True if two secrets allowlists differ meaningfully (order/case/dupes ignored)
 * — a replayed idempotent create naming a DIFFERENT secret set must conflict
 * rather than silently reuse the first. Mirrors connectorBindingPayloadConflicts.
 */
export function secretsAllowlistPayloadConflicts(
  a: string[] | null | undefined,
  b: string[] | null | undefined,
): boolean {
  const ca = canonicalizeSecretsAllowlist(a);
  const cb = canonicalizeSecretsAllowlist(b);
  if (ca === null || cb === null) return ca !== cb;
  return ca.length !== cb.length || ca.some((id, i) => id !== cb[i]);
}

export function projectSecretsRevision(env: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function listProjectSecretsSnapshot(projectId: string): Promise<{
  env: Record<string, string>;
  names: string[];
  revision: string;
}> {
  const env = await listProjectSecrets(projectId);
  const names = Object.keys(env).sort();
  return {
    env,
    names,
    revision: projectSecretsRevision(env),
  };
}

/**
 * Per-user, per-agent-grant snapshot — the sandbox-boot view. `grantEnv` is the
 * running agent's `secrets` grant (`AgentGrant.env`); omitted/`'all'` = every
 * secret in the project reaches this session (see resolveGrantedSecretEnv).
 */
/**
 * THE chokepoint: everything a sandbox is handed passes through here.
 *
 * Two production callers — sandbox boot (`buildSessionSandboxEnvVars`) and the
 * per-prompt hot push (`resolveOwnerRawEnv`) — which is why the delivery
 * decision belongs here rather than at either of them. A row's `strategy`
 * decides whether its value may enter the box AT ALL; the pre-existing grant and
 * allowlist narrowing decide only WHICH rows are considered.
 *
 * `sessionId` is required to deliver anything non-`runtime`: a brokered value is
 * represented in the box by a per-session handle, and with no session there is
 * nothing to mint against. Absent it, non-`runtime` rows are withheld rather
 * than falling back to plaintext — the fallback would defeat the whole point.
 */
/**
 * Delete from `env` every KEY that no longer has a deliverable value.
 *
 * Mutates in place because the caller owns the map and this is a pure narrowing
 * of it — a row whose delivery says "nothing" is removed from the values, and
 * therefore from `names`, which the daemon derives from the same map. (A name
 * emitted without a value, or the reverse, desynchronises the box's env store.)
 *
 * The subtlety is the SHARED KEY. Two identifiers may resolve to one env KEY —
 * that is deliberate, so an agent can be granted one specific value among
 * several candidates for the same variable. A KEY may therefore only be dropped
 * when EVERY identifier behind it is undeliverable; if one is still `runtime`,
 * the KEY has a legitimate value and dropping it would break a working session.
 */
export function withholdUndeliverable(
  rows: ResolvedProjectSecret[],
  env: Record<string, string>,
  sessionId: string | null,
): void {
  const deliverableKeys = new Set<string>();
  const seenKeys = new Set<string>();
  for (const row of rows) {
    seenKeys.add(row.key);
    const delivery = resolveSecretDelivery({
      identifier: row.identifier,
      strategy: row.strategy,
      sessionId,
      // The agent grant and the session allowlist were BOTH applied upstream by
      // resolveGrantedSecretEnv; re-applying them here would double-count and
      // could withhold a row the caller already admitted.
      agentGrantEnv: 'all',
      sessionAllowlist: null,
    });
    if (emitsValue(delivery)) deliverableKeys.add(row.key);
  }
  for (const key of seenKeys) {
    if (!deliverableKeys.has(key)) delete env[key];
  }
}

export type SecretHandleMinter = (row: ResolvedProjectSecret) => Promise<string>;

/**
 * Replace selected plaintext values with delivery-safe material.
 *
 * `rows` contains one deterministic winner per env key. The function mutates
 * the caller-owned map. It never adds a key that the grant resolver excluded.
 */
export async function materializeSecretDelivery(
  rows: ResolvedProjectSecret[],
  env: Record<string, string>,
  input: {
    sessionId: string | null;
    grantEnv: string[] | 'all' | undefined;
    mintHandleFor: SecretHandleMinter;
  },
): Promise<void> {
  for (const row of rows) {
    if (!(row.key in env)) continue;
    const delivery = resolveSecretDelivery({
      identifier: row.identifier,
      strategy: row.strategy,
      sessionId: input.sessionId,
      agentGrantEnv: input.grantEnv ?? null,
      sessionAllowlist: null,
    });
    const consumer =
      row.consumer ??
      (delivery.strategy === 'runtime'
        ? 'sandbox'
        : row.egressPolicy?.backend === 'kortix_fetch'
          ? 'http_broker'
          : (row.egressPolicy?.backend ?? null));
    if (delivery.emit === 'plaintext' && consumer === 'sandbox') continue;
    if (
      delivery.emit === 'handle' &&
      delivery.strategy === 'broker' &&
      consumer === 'http_broker' &&
      row.egressPolicy?.backend === 'kortix_fetch'
    ) {
      env[row.key] = await input.mintHandleFor(row);
      continue;
    }
    delete env[row.key];
  }
}

async function mintSessionSecretHandle(
  projectId: string,
  sessionId: string,
  row: ResolvedProjectSecret,
): Promise<string> {
  const egressPolicy = row.egressPolicy;
  if (!egressPolicy) throw new Error('Managed secret delivery requires a policy');

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${sessionId}:${row.secretId}`}, 0))`,
    );
    const [session] = await tx
      .select({ accountId: projectSessions.accountId })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
      )
      .limit(1);
    if (!session) throw new Error('Cannot mint a secret handle without its project session');

    const [latest] = await tx
      .select()
      .from(projectSessionSecretHandles)
      .where(
        and(
          eq(projectSessionSecretHandles.sessionId, sessionId),
          eq(projectSessionSecretHandles.secretId, row.secretId),
        ),
      )
      .orderBy(desc(projectSessionSecretHandles.revision))
      .limit(1);

    const policyMatches =
      latest && JSON.stringify(latest.policySnapshot) === JSON.stringify(egressPolicy);
    const notExpired = !latest?.expiresAt || latest.expiresAt.getTime() > Date.now();
    if (latest?.status === 'active' && policyMatches && notExpired) {
      const handle = mintHandle({
        lookupId: latest.lookupId,
        prefix: row.handlePrefix,
        rootSecret: config.API_KEY_SECRET,
      });
      const hash = createHash('sha256').update(handle).digest('hex');
      if (hash !== latest.handleHash) {
        await tx
          .update(projectSessionSecretHandles)
          .set({ status: 'revoked', revokedAt: new Date() })
          .where(eq(projectSessionSecretHandles.handleId, latest.handleId));
        throw new Error('Stored secret handle integrity check failed');
      }
      return {
        handle,
        issued: false,
        accountId: session.accountId,
        revision: latest.revision,
      };
    }

    if (latest?.status === 'active') {
      await tx
        .update(projectSessionSecretHandles)
        .set({ status: 'superseded' })
        .where(eq(projectSessionSecretHandles.handleId, latest.handleId));
    }
    const revision = (latest?.revision ?? 0) + 1;
    const lookupId = newLookupId(randomBytes(20));
    const handle = mintHandle({
      lookupId,
      prefix: row.handlePrefix,
      rootSecret: config.API_KEY_SECRET,
    });
    await tx.insert(projectSessionSecretHandles).values({
      projectId,
      sessionId,
      secretId: row.secretId,
      identifier: row.identifier,
      envName: row.key,
      lookupId,
      handleHash: createHash('sha256').update(handle).digest('hex'),
      revision,
      policySnapshot: egressPolicy,
      status: 'active',
    });
    return { handle, issued: true, accountId: session.accountId, revision };
  });

  if (result.issued) {
    await recordAuditEvent({
      accountId: result.accountId,
      projectId,
      sessionId,
      actorType: 'system',
      source: 'system',
      action: 'secret.handle.issued',
      resourceType: 'project_secret',
      resourceId: row.secretId,
      metadata: {
        identifier: row.identifier,
        consumer: 'http_broker',
        strategy: 'broker',
        revision: result.revision,
      },
    });
  }
  return result.handle;
}

export async function listProjectSecretsSnapshotForUser(
  projectId: string,
  userId: string | null,
  grantEnv?: string[] | 'all',
  sessionId?: string | null,
): Promise<{
  env: Record<string, string>;
  names: string[];
  revision: string;
  capabilities: SecretCapabilityCatalog;
  capabilitiesJson: string;
}> {
  const rows = await listResolvedProjectSecrets(projectId, userId);
  const { env, selected } = resolveGrantedSecretSelection(rows, grantEnv);
  await materializeSecretDelivery(selected, env, {
    sessionId: sessionId ?? null,
    grantEnv,
    mintHandleFor: async (row) => {
      if (!sessionId) throw new Error('Secret handle delivery requires a session');
      return mintSessionSecretHandle(projectId, sessionId, row);
    },
  });

  const names = Object.keys(env).sort();
  const capabilities = buildSecretCapabilities(selected, {
    grantEnv,
    sessionId: sessionId ?? null,
  });
  return {
    env,
    names,
    revision: projectSecretsRevision(env),
    capabilities,
    capabilitiesJson: serializeSecretCapabilities(capabilities),
  };
}

export async function getProjectSecretValue(
  projectId: string,
  name: string,
): Promise<string | null> {
  const normalizedName = name.trim().toUpperCase();
  const rows = await db
    .select({
      identifier: projectSecrets.identifier,
      valueEnc: projectSecrets.valueEnc,
      updatedAt: projectSecrets.updatedAt,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, normalizedName),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  if (rows.length === 0) return null;
  // Deterministic pick when multiple identifiers share this key: the canonical
  // (identifier === key) row wins, else the most-recently-updated one.
  const canonical = rows.find((r) => r.identifier === normalizedName);
  const row =
    canonical ?? [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!;
  return decryptProjectSecret(projectId, row.valueEnc);
}

export interface ProjectSecretConsumerRead {
  projectId: string;
  accountId?: string;
  sessionId?: string | null;
  actorUserId?: string | null;
  /** Select this user's active personal override before the shared value. */
  principalUserId?: string | null;
  name: string;
  consumer: Exclude<SecretConsumer, 'sandbox' | 'network' | 'http_broker'>;
}

export interface ProjectSecretConsumerValue {
  accountId: string;
  secretId: string;
  identifier: string;
  ownerUserId: string | null;
  updatedAt: Date;
  value: string;
}

export async function projectSecretIsConfiguredForConsumer(input: {
  projectId: string;
  name: string;
  consumer: Exclude<SecretConsumer, 'sandbox' | 'network' | 'http_broker'>;
}): Promise<boolean> {
  const normalizedName = input.name.trim().toUpperCase();
  const rows = await db
    .select({
      scope: projectSecrets.scope,
      strategy: projectSecrets.strategy,
      consumer: projectSecrets.consumer,
      active: projectSecrets.active,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, input.projectId),
        eq(projectSecrets.name, normalizedName),
        isNull(projectSecrets.ownerUserId),
      ),
    );
  return rows.some(
    (row) =>
      row.active &&
      (input.consumer === 'connector'
        ? row.scope === 'connector' ||
          (row.strategy === 'broker' && row.consumer === 'connector')
        : row.strategy === 'broker' && row.consumer === input.consumer),
  );
}

export async function listProjectSecretNamesForConsumer(input: {
  projectId: string;
  principalUserId?: string | null;
  consumer: Exclude<SecretConsumer, 'sandbox' | 'network' | 'http_broker'>;
}): Promise<string[]> {
  const rows = await db
    .select({
      identifier: projectSecrets.identifier,
      name: projectSecrets.name,
      scope: projectSecrets.scope,
      strategy: projectSecrets.strategy,
      consumer: projectSecrets.consumer,
      ownerUserId: projectSecrets.ownerUserId,
      active: projectSecrets.active,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, input.projectId),
        input.principalUserId
          ? or(
              isNull(projectSecrets.ownerUserId),
              eq(projectSecrets.ownerUserId, input.principalUserId),
            )
          : isNull(projectSecrets.ownerUserId),
      ),
    );

  type Row = (typeof rows)[number];
  const byIdentifier = new Map<string, { shared?: Row; personal?: Row }>();
  for (const row of rows) {
    const slot = byIdentifier.get(row.identifier) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else if (row.ownerUserId === input.principalUserId) slot.personal = row;
    byIdentifier.set(row.identifier, slot);
  }

  const names = new Set<string>();
  for (const slot of byIdentifier.values()) {
    const selected = slot.personal?.active ? slot.personal : slot.shared;
    if (!selected?.active || selected.name.toUpperCase().startsWith('KORTIX_')) continue;
    const policy = slot.shared ?? selected;
    const configured =
      input.consumer === 'connector'
        ? (policy.strategy === 'broker' && policy.consumer === 'connector') ||
          (policy.scope === 'connector' &&
            (policy.consumer === 'connector' || policy.consumer === 'sandbox'))
        : policy.strategy === 'broker' && policy.consumer === input.consumer;
    if (configured) names.add(selected.name.toUpperCase());
  }
  return [...names].sort();
}

/** Resolve up to maxValues in deterministic fallback order. */
async function resolveProjectSecretValuesForConsumer(
  input: ProjectSecretConsumerRead,
  maxValues: number,
): Promise<ProjectSecretConsumerValue[]> {
  const accountId =
    input.accountId ??
    (
      await db
        .select({ accountId: projects.accountId })
        .from(projects)
        .where(eq(projects.projectId, input.projectId))
        .limit(1)
    )[0]?.accountId;
  if (!accountId) return [];
  const normalizedName = input.name.trim().toUpperCase();
  const rows = await db
    .select({
      secretId: projectSecrets.secretId,
      identifier: projectSecrets.identifier,
      ownerUserId: projectSecrets.ownerUserId,
      valueEnc: projectSecrets.valueEnc,
      scope: projectSecrets.scope,
      active: projectSecrets.active,
      strategy: projectSecrets.strategy,
      consumer: projectSecrets.consumer,
      updatedAt: projectSecrets.updatedAt,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, input.projectId),
        eq(projectSecrets.name, normalizedName),
        input.principalUserId
          ? or(
              isNull(projectSecrets.ownerUserId),
              eq(projectSecrets.ownerUserId, input.principalUserId),
            )
          : isNull(projectSecrets.ownerUserId),
      ),
    );
  if (rows.length === 0) {
    await recordAuditEvent({
      accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      actorType: input.sessionId ? 'agent' : input.actorUserId ? 'human' : 'system',
      source: input.consumer,
      outcome: 'denied',
      action: 'secret.consumer.missing',
      resourceType: 'project_secret',
      metadata: { name: normalizedName, consumer: input.consumer },
    });
    return [];
  }

  type Row = (typeof rows)[number];
  const byIdentifier = new Map<string, { shared?: Row; personal?: Row }>();
  for (const row of rows) {
    const slot = byIdentifier.get(row.identifier) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else if (row.ownerUserId === input.principalUserId) slot.personal = row;
    byIdentifier.set(row.identifier, slot);
  }

  const selectedRows = [...byIdentifier.entries()]
    .map(([identifier, slot]) => ({
      identifier,
      row: slot.personal?.active ? slot.personal : (slot.shared ?? slot.personal),
      policyRow: slot.shared ?? slot.personal,
    }))
    .filter(
      (entry): entry is { identifier: string; row: Row; policyRow: Row } =>
        Boolean(entry.row && entry.policyRow),
    )
    .sort((a, b) => {
      if (a.identifier === normalizedName) return -1;
      if (b.identifier === normalizedName) return 1;
      const updatedDifference = b.row.updatedAt.getTime() - a.row.updatedAt.getTime();
      return updatedDifference || a.identifier.localeCompare(b.identifier);
    });

  const resolved: ProjectSecretConsumerValue[] = [];
  for (const { row, policyRow } of selectedRows) {
    const allowed =
      row.active &&
      (input.consumer === 'connector'
        ? (policyRow.strategy === 'broker' && policyRow.consumer === 'connector') ||
          (policyRow.scope === 'connector' &&
            (policyRow.consumer === 'connector' || policyRow.consumer === 'sandbox'))
        : policyRow.strategy === 'broker' && policyRow.consumer === input.consumer);
    if (!allowed) {
      await recordAuditEvent({
        accountId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        actorType: input.sessionId ? 'agent' : input.actorUserId ? 'human' : 'system',
        source: input.consumer,
        outcome: 'denied',
        action: 'secret.consumer.denied',
        resourceType: 'project_secret',
        resourceId: row.secretId,
        metadata: {
          identifier: row.identifier,
          name: normalizedName,
          requested_consumer: input.consumer,
          configured_consumer: policyRow.consumer,
          strategy: policyRow.strategy,
          value_source: row.ownerUserId ? 'personal' : 'shared',
        },
      });
      continue;
    }

    let value: string;
    try {
      value = decryptProjectSecret(input.projectId, row.valueEnc);
    } catch {
      await recordAuditEvent({
        accountId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        actorType: input.sessionId ? 'agent' : input.actorUserId ? 'human' : 'system',
        source: input.consumer,
        outcome: 'failure',
        action: 'secret.consumer.invalid',
        resourceType: 'project_secret',
        resourceId: row.secretId,
        metadata: {
          identifier: row.identifier,
          name: normalizedName,
          consumer: input.consumer,
          value_source: row.ownerUserId ? 'personal' : 'shared',
        },
      });
      continue;
    }
    await recordAuditEvent({
      accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      actorType: input.sessionId ? 'agent' : input.actorUserId ? 'human' : 'system',
      source: input.consumer,
      action: 'secret.consumer.used',
      resourceType: 'project_secret',
      resourceId: row.secretId,
      metadata: {
        identifier: row.identifier,
        name: normalizedName,
        consumer: input.consumer,
        value_source: row.ownerUserId ? 'personal' : 'shared',
      },
    });
    resolved.push({
      accountId,
      secretId: row.secretId,
      identifier: row.identifier,
      ownerUserId: row.ownerUserId,
      updatedAt: row.updatedAt,
      value,
    });
    if (resolved.length >= maxValues) break;
  }
  return resolved;
}

/** Resolve every authorized value for one key through its server consumer. */
export async function resolveProjectSecretsForConsumer(
  input: ProjectSecretConsumerRead,
): Promise<ProjectSecretConsumerValue[]> {
  return resolveProjectSecretValuesForConsumer(input, Number.POSITIVE_INFINITY);
}

/** Resolve the first authorized value in deterministic fallback order. */
export async function resolveProjectSecretForConsumer(
  input: ProjectSecretConsumerRead,
): Promise<ProjectSecretConsumerValue | null> {
  return (await resolveProjectSecretValuesForConsumer(input, 1))[0] ?? null;
}

export async function getProjectSecretValueForConsumer(
  input: ProjectSecretConsumerRead,
): Promise<string | null> {
  return (await resolveProjectSecretForConsumer(input))?.value ?? null;
}
