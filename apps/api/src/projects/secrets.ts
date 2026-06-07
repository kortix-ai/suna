import {
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { projectSecrets } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { isSecretUsableBy, loadGrants, type ShareSubject } from '../executor/share';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENVELOPE_VERSION = 'v1';

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
  const cipher = createCipheriv('aes-256-gcm', projectSecretKey(projectId), iv);
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
  const decipher = createDecipheriv('aes-256-gcm', projectSecretKey(projectId), fromB64url(ivB64));
  decipher.setAuthTag(fromB64url(tagB64));
  return Buffer.concat([
    decipher.update(fromB64url(ciphertextB64)),
    decipher.final(),
  ]).toString('utf8');
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
async function listProjectSecretsForUser(
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

function projectSecretsRevision(env: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
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
