import {
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { projectSecrets } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';

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
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_VERSION}:${b64url(iv)}:${b64url(tag)}:${b64url(ciphertext)}`;
}

export function decryptProjectSecret(projectId: string, valueEnc: string): string {
  const [version, ivB64, tagB64, ciphertextB64] = valueEnc.split(':');
  if (version !== ENVELOPE_VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
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
  return Buffer.concat([
    decipher.update(fromB64url(ciphertextB64)),
    decipher.final(),
  ]).toString('utf8');
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
    // Executor gateway — never injected into the sandbox env.
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
  identifier: string;
  key: string;
  value: string;
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
      identifier: projectSecrets.identifier,
      name: projectSecrets.name,
      valueEnc: projectSecrets.valueEnc,
      scope: projectSecrets.scope,
      ownerUserId: projectSecrets.ownerUserId,
      active: projectSecrets.active,
    })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.scope, 'runtime'),
      userId ? or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, userId)) : isNull(projectSecrets.ownerUserId),
    ));

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
    out.push({ identifier, key: chosen.name, value: decryptProjectSecret(projectId, chosen.valueEnc) });
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
export function resolveGrantedSecretEnv(
  rows: ResolvedProjectSecret[],
  grant: string[] | 'all' | undefined,
): { env: Record<string, string>; identifiers: string[] } {
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
  for (const [key, candidates] of byKey) {
    if (candidates.length === 1) {
      env[key] = candidates[0]!.value;
      continue;
    }
    if (!allowAll) {
      throw new AmbiguousSecretGrantError(
        key,
        candidates.map((c) => c.identifier).sort(),
      );
    }
    const winner = [...candidates].sort((a, b) => a.identifier.localeCompare(b.identifier))[0]!;
    env[key] = winner.value;
  }

  return { env, identifiers: allowed.map((r) => r.identifier) };
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
export async function listProjectSecretsSnapshotForUser(
  projectId: string,
  userId: string | null,
  grantEnv?: string[] | 'all',
): Promise<{ env: Record<string, string>; names: string[]; revision: string }> {
  const rows = await listResolvedProjectSecrets(projectId, userId);
  const { env } = resolveGrantedSecretEnv(rows, grantEnv);
  const names = Object.keys(env).sort();
  return { env, names, revision: projectSecretsRevision(env) };
}

export async function getProjectSecretValue(
  projectId: string,
  name: string,
): Promise<string | null> {
  const normalizedName = name.trim().toUpperCase();
  const rows = await db
    .select({ identifier: projectSecrets.identifier, valueEnc: projectSecrets.valueEnc, updatedAt: projectSecrets.updatedAt })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, normalizedName),
      isNull(projectSecrets.ownerUserId),
    ));
  if (rows.length === 0) return null;
  // Deterministic pick when multiple identifiers share this key: the canonical
  // (identifier === key) row wins, else the most-recently-updated one.
  const canonical = rows.find((r) => r.identifier === normalizedName);
  const row = canonical ?? [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!;
  return decryptProjectSecret(projectId, row.valueEnc);
}

interface ResolvableSecretRow {
  identifier: string;
  ownerUserId: string | null;
  valueEnc: string;
  updatedAt: Date;
}

/**
 * Pure pick logic for `getResolvedProjectSecretValue` (factored out so it's
 * unit-testable without a DB): given every row visible to `userId` for a KEY
 * (the SHARED row plus, if `userId` is set, THAT user's own PRIVATE row —
 * never anyone else's), decide which one resolves.
 *
 * The SHARED row always wins when one exists — it's the workspace's
 * deliberate resource, and one member's private key should never silently
 * swap in for it. The private row is only a FALLBACK for when NO shared key
 * has been configured for this provider at all, so a member who saved their
 * own key can still use it in their OWN sessions instead of hitting
 * "No upstream configured" while every other secret-scoping surface reports
 * it as connected (the 2026-07-07 / recurring self-host incident).
 */
export function pickResolvedSecretRow<T extends ResolvableSecretRow>(
  rows: T[],
  normalizedName: string,
  userId: string | null,
): T | null {
  const pick = (candidates: T[]): T | null => {
    if (candidates.length === 0) return null;
    const canonical = candidates.find((r) => r.identifier === normalizedName);
    return canonical ?? [...candidates].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!;
  };
  const shared = pick(rows.filter((r) => r.ownerUserId === null));
  if (shared) return shared;
  if (!userId) return null;
  return pick(rows.filter((r) => r.ownerUserId === userId));
}

/**
 * Resolve a BYOK provider credential (by env-var KEY) for a specific session's
 * ACTING user: the project's SHARED key, falling back to that user's own
 * PRIVATE override when no shared key exists. Used by gateway upstream
 * resolution (`resolveCandidates`) instead of `getProjectSecretValue` so a
 * member's own private key routes their own sessions instead of leaving the
 * gateway blind to it. `userId` null (no acting human, e.g. a webhook-
 * triggered session) behaves exactly like `getProjectSecretValue` (shared-only).
 */
export async function getResolvedProjectSecretValue(
  projectId: string,
  name: string,
  userId: string | null,
): Promise<string | null> {
  const normalizedName = name.trim().toUpperCase();
  const rows = await db
    .select({
      identifier: projectSecrets.identifier,
      valueEnc: projectSecrets.valueEnc,
      updatedAt: projectSecrets.updatedAt,
      ownerUserId: projectSecrets.ownerUserId,
    })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, normalizedName),
      userId
        ? or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, userId))
        : isNull(projectSecrets.ownerUserId),
    ));
  const chosen = pickResolvedSecretRow(rows, normalizedName, userId);
  if (!chosen) return null;
  return decryptProjectSecret(projectId, chosen.valueEnc);
}
