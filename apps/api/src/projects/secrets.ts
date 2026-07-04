import {
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { projectSecretGrants, projectSecrets } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { isSecretUsableBy, loadGrants, type ShareSubject } from '../executor/share';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;
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
 * value. Mirrors the POST /secrets handler's insert/onConflict, factored out so
 * the public setup-link intake endpoint (no authenticated user) can write the
 * value a human supplied via a minted link. `scope` is only set on first insert
 * — an existing connector-scoped row keeps its scope on re-submit.
 */
export async function writeSharedProjectSecret(input: {
  projectId: string;
  name: string;
  value: string;
  scope?: 'runtime' | 'connector';
  createdBy?: string | null;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(projectSecrets)
    .values({
      projectId: input.projectId,
      name: input.name,
      valueEnc: encryptProjectSecret(input.projectId, input.value),
      scope: input.scope ?? 'runtime',
      createdBy: input.createdBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectSecrets.projectId, projectSecrets.name],
      targetWhere: isNull(projectSecrets.ownerUserId),
      set: {
        valueEnc: encryptProjectSecret(input.projectId, input.value),
        updatedAt: now,
      },
    });
}

/**
 * Decrypted key->value map of the project's SHARED runtime secrets (owner_user_id
 * IS NULL). Platform-reserved KORTIX_* rows are excluded so legacy system secrets
 * can never leak into the sandbox as user-controlled env vars. This is the
 * project-scoped view used by non-sandbox callers (e.g. Slack install lookup);
 * sandbox boot uses `listProjectSecretsForUser` so per-user overrides and
 * share-scope restrictions are honored.
 */
export async function listProjectSecrets(projectId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({
      name: projectSecrets.name,
      valueEnc: projectSecrets.valueEnc,
      scope: projectSecrets.scope,
    })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), isNull(projectSecrets.ownerUserId)));

  const env: Record<string, string> = {};
  for (const row of rows) {
    if (row.name.toUpperCase().startsWith('KORTIX_')) continue;
    // Connector credentials / Pipedream bindings are resolved server-side by the
    // Executor gateway — never injected into the sandbox env.
    if (row.scope === 'connector') continue;
    env[row.name] = decryptProjectSecret(projectId, row.valueEnc);
  }
  return env;
}

/**
 * Decrypted runtime-secret env map AS SEEN BY a specific user launching a
 * session. This is the authoritative sandbox-boot resolver. For each key:
 *
 *   1. the user's own ACTIVE personal override wins ("use mine"), else
 *   2. the shared project row, but only if it's shared with the user
 *      (project-wide, or the user is in the allow-list), else
 *   3. the key is not injected.
 *
 * Enforcing (2) is what makes "Only me" / "Select members" sharing actually
 * restrict what lands in a member's sandbox env.
 */
export async function listProjectSecretsForUser(
  projectId: string,
  subject: ShareSubject,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      secretId: projectSecrets.secretId,
      name: projectSecrets.name,
      valueEnc: projectSecrets.valueEnc,
      scope: projectSecrets.scope,
      shareScope: projectSecrets.shareScope,
      ownerUserId: projectSecrets.ownerUserId,
      active: projectSecrets.active,
    })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, subject.userId)),
    ));

  type Row = (typeof rows)[number];
  const byName = new Map<string, { shared?: Row; personal?: Row }>();
  for (const row of rows) {
    const slot = byName.get(row.name) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else slot.personal = row;
    byName.set(row.name, slot);
  }

  // Grants only matter for shared rows that are restricted.
  const grants = await loadGrants(
    rows.filter((r) => r.ownerUserId === null).map((r) => r.secretId),
  );

  const env: Record<string, string> = {};
  for (const [name, slot] of byName) {
    if (name.toUpperCase().startsWith('KORTIX_')) continue;
    let chosen: Row | undefined;
    if (slot.personal && slot.personal.active) {
      chosen = slot.personal;
    } else if (
      slot.shared &&
      isSecretUsableBy(slot.shared.shareScope, grants.get(slot.shared.secretId) ?? [], subject)
    ) {
      chosen = slot.shared;
    }
    if (!chosen) continue;
    if (chosen.scope === 'connector') continue;
    env[name] = decryptProjectSecret(projectId, chosen.valueEnc);
  }
  return env;
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

/** Per-user snapshot — the sandbox-boot view (overrides + share-scope applied). */
export async function listProjectSecretsSnapshotForUser(
  projectId: string,
  subject: ShareSubject,
): Promise<{ env: Record<string, string>; names: string[]; revision: string }> {
  const env = await listProjectSecretsForUser(projectId, subject);
  const names = Object.keys(env).sort();
  return { env, names, revision: projectSecretsRevision(env) };
}

export async function getProjectSecretValue(
  projectId: string,
  name: string,
): Promise<string | null> {
  const normalizedName = name.trim().toUpperCase();
  const [row] = await db
    .select({ valueEnc: projectSecrets.valueEnc })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, normalizedName),
      isNull(projectSecrets.ownerUserId),
    ))
    .limit(1);

  return row ? decryptProjectSecret(projectId, row.valueEnc) : null;
}

/**
 * Decrypted values for the named SHARED secrets — used ONLY for agent-resource
 * inheritance (an `inherit`=true agent that an EXPLICITLY-ASSIGNED launcher
 * runs). This deliberately BYPASSES the per-user share scope: the agent DECLARED
 * (in kortix.toml, PR-reviewed) that it needs these, and the launcher is
 * explicitly assigned to it. Bounded to the caller's name list; KORTIX_* and
 * connector-scoped rows are never returned. Do NOT use for general secret reads.
 */
export async function resolveDeclaredSharedSecrets(
  projectId: string,
  names: string[],
): Promise<Record<string, string>> {
  if (names.length === 0) return {};
  const rows = await db
    .select({ name: projectSecrets.name, valueEnc: projectSecrets.valueEnc, scope: projectSecrets.scope })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      isNull(projectSecrets.ownerUserId),
      inArray(projectSecrets.name, names),
    ));
  const env: Record<string, string> = {};
  for (const row of rows) {
    if (row.name.toUpperCase().startsWith('KORTIX_')) continue;
    if (row.scope === 'connector') continue;
    env[row.name] = decryptProjectSecret(projectId, row.valueEnc);
  }
  return env;
}

// ─── Secret → agent access (the secret-side allowlist) ──────────────────────
// Which agents may use a shared secret. NULL/empty `agent_scope` = all agents
// (project-wide, default); a non-empty list of agent NAMES restricts it to those
// agents' sessions. The executor (buildSessionSandboxEnvVars) reads the scopes
// and drops any secret whose allowlist excludes the running agent — an ADDITIVE
// narrowing on top of the share model, never a widening.

/**
 * Secret NAME → agent-name allowlist, for every shared project secret RESTRICTED
 * to specific agents (non-empty `agent_scope`). All-agents secrets (NULL/empty)
 * are omitted — the executor only needs the restricted ones to know what to drop.
 */
export async function loadSecretAgentScopes(projectId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ name: projectSecrets.name, agentScope: projectSecrets.agentScope })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), isNull(projectSecrets.ownerUserId)));
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const scope = row.agentScope;
    if (Array.isArray(scope) && scope.length > 0) map.set(row.name, scope);
  }
  return map;
}

/**
 * Given the project's secret→agent scopes (name → allowed agent names) and the
 * agent a session runs AS, the set of secret names that agent may NOT use — a
 * secret is denied iff it's scoped (present in the map) and its allowlist
 * excludes the agent. All-agents secrets never enter the map, so they're never
 * denied. Pure: this is the whole security decision the executor applies.
 */
export function secretNamesDeniedForAgent(
  scopes: ReadonlyMap<string, string[]>,
  agentName: string,
): Set<string> {
  const denied = new Set<string>();
  for (const [name, allowed] of scopes) {
    if (!allowed.includes(agentName)) denied.add(name);
  }
  return denied;
}

/**
 * Set (or clear) the agent allowlist for a shared secret. `agents = null` or an
 * empty array clears it → usable by ALL agents again. Names are trimmed, empties
 * dropped, deduped. Returns false when the shared secret row doesn't exist.
 */
export async function setSecretAgentScope(
  projectId: string,
  name: string,
  agents: string[] | null,
): Promise<boolean> {
  const normalizedName = name.trim().toUpperCase();
  const cleaned = agents ? Array.from(new Set(agents.map((a) => a.trim()).filter(Boolean))) : [];
  const res = await db
    .update(projectSecrets)
    .set({ agentScope: cleaned.length > 0 ? cleaned : null, updatedAt: new Date() })
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, normalizedName),
      isNull(projectSecrets.ownerUserId),
    ))
    .returning({ secretId: projectSecrets.secretId });
  return res.length > 0;
}

// ─── Secret access as resource grants ───────────────────────────────────────
// The "Resource access" card (Members) and the Secret "Who can access this"
// dialog both operate on ONE source of truth for secret audience: the share
// model (project_secret_grants + share_scope). These helpers expose that model
// in the resource-grant shape the card speaks, so a change in either surface
// shows in both. (Agents/skills still live in iam_resource_grants.)

export interface SecretResourceGrant {
  grantId: string;
  /** The secret NAME — the resource id the card keys on. */
  name: string;
  principalType: 'member' | 'group';
  principalId: string;
  createdAt: Date;
}

/** Every member/department grant on the project's SHARED, restricted secrets. */
export async function listSecretResourceGrants(projectId: string): Promise<SecretResourceGrant[]> {
  const rows = await db
    .select({
      grantId: projectSecretGrants.grantId,
      name: projectSecrets.name,
      principalType: projectSecretGrants.principalType,
      principalId: projectSecretGrants.principalId,
      createdAt: projectSecretGrants.createdAt,
    })
    .from(projectSecretGrants)
    .innerJoin(projectSecrets, eq(projectSecrets.secretId, projectSecretGrants.secretId))
    .where(and(eq(projectSecrets.projectId, projectId), isNull(projectSecrets.ownerUserId)));
  return rows.map((r) => ({ ...r, principalType: r.principalType as 'member' | 'group' }));
}

/**
 * Grant a shared secret to a member/department. Adding the first grant flips the
 * secret from project-wide to restricted (its allow-list) — the same semantic as
 * the dialog's "Specific members or departments". Idempotent on (secret,principal).
 * Returns null if the secret doesn't exist.
 */
export async function addSecretResourceGrant(input: {
  projectId: string;
  name: string;
  principalType: 'member' | 'group';
  principalId: string;
}): Promise<{ grantId: string } | null> {
  // One transaction with a row lock on the secret so a concurrent add/remove on
  // the same secret can't interleave (which could strand a live grant on a
  // project-wide — i.e. open — scope). onConflictDoUpdate (no-op set) makes the
  // insert idempotent AND always RETURN the grant id.
  return db.transaction(async (tx) => {
    const [secret] = await tx
      .select({ secretId: projectSecrets.secretId })
      .from(projectSecrets)
      .where(and(
        eq(projectSecrets.projectId, input.projectId),
        eq(projectSecrets.name, input.name),
        isNull(projectSecrets.ownerUserId),
      ))
      .for('update')
      .limit(1);
    if (!secret) return null;
    const [grant] = await tx
      .insert(projectSecretGrants)
      .values({ secretId: secret.secretId, principalType: input.principalType, principalId: input.principalId })
      .onConflictDoUpdate({
        target: [projectSecretGrants.secretId, projectSecretGrants.principalType, projectSecretGrants.principalId],
        set: { principalId: input.principalId },
      })
      .returning({ grantId: projectSecretGrants.grantId });
    await tx
      .update(projectSecrets)
      .set({ shareScope: 'restricted', updatedAt: new Date() })
      .where(eq(projectSecrets.secretId, secret.secretId));
    return grant ? { grantId: grant.grantId } : null;
  });
}

/**
 * Remove a secret grant by id (scoped to the project so a guessed id can't touch
 * a foreign project). When the last grant goes, the secret reverts to
 * project-wide (open) — the empty-allow-list-collapses-to-project rule.
 */
export async function removeSecretResourceGrant(grantId: string, projectId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ secretId: projectSecretGrants.secretId })
      .from(projectSecretGrants)
      .innerJoin(projectSecrets, eq(projectSecrets.secretId, projectSecretGrants.secretId))
      .where(and(eq(projectSecretGrants.grantId, grantId), eq(projectSecrets.projectId, projectId)))
      .limit(1);
    if (!row) return false;
    // Lock the secret so the delete + remaining-count + revert is atomic against
    // a concurrent addSecretResourceGrant on the same secret.
    await tx
      .select({ id: projectSecrets.secretId })
      .from(projectSecrets)
      .where(eq(projectSecrets.secretId, row.secretId))
      .for('update');
    await tx.delete(projectSecretGrants).where(eq(projectSecretGrants.grantId, grantId));
    const remaining = await tx
      .select({ id: projectSecretGrants.grantId })
      .from(projectSecretGrants)
      .where(eq(projectSecretGrants.secretId, row.secretId))
      .limit(1);
    if (remaining.length === 0) {
      await tx
        .update(projectSecrets)
        .set({ shareScope: 'project', updatedAt: new Date() })
        .where(eq(projectSecrets.secretId, row.secretId));
    }
    return true;
  });
}
