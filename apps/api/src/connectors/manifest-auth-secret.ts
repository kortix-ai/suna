/**
 * kortix.yaml owns `connectors[].auth.secret`: binding a secret to a connector
 * (or clearing it) commits the change to the file before the row changes.
 */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { withProjectGitAuth } from '../projects/surface';
import { db } from '../shared/db';
import { mutateManifestWithRetry, type ManifestCommitResult } from './manifest-mutation';

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `entry` with `auth.secret` set, or removed when `secret` is null (an empty `auth` goes too). */
export function withAuthSecret(entry: Row, secret: string | null): Row {
  const auth: Row = isRow(entry.auth) ? { ...entry.auth } : {};
  if (secret === null) delete auth.secret;
  else auth.secret = secret;
  const { auth: _drop, ...rest } = entry;
  return Object.keys(auth).length ? { ...rest, auth } : rest;
}

export async function commitConnectorAuthSecret(projectId: string, slug: string, secret: string | null): Promise<ManifestCommitResult> {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!row) return { ok: false, error: 'project not found', status: 404 };
  let project: Awaited<ReturnType<typeof withProjectGitAuth>>;
  try {
    project = await withProjectGitAuth(row);
  } catch (error) {
    return { ok: false, error: (error as Error).message || 'failed to read kortix.yaml', status: 409 };
  }
  return mutateManifestWithRetry(project, `the connector ${slug} credential was being bound`, (manifest) => {
    const list = Array.isArray(manifest.raw.connectors) ? [...(manifest.raw.connectors as Row[])] : [];
    const index = list.findIndex((entry) => isRow(entry) && entry.slug === slug);
    // A connector kortix.yaml does not declare (a channel, a computer) has no entry to change.
    if (index < 0) return { ok: true, commitMessage: null };
    const next = withAuthSecret(list[index]!, secret);
    if (JSON.stringify(next) === JSON.stringify(list[index])) return { ok: true, commitMessage: null };
    list[index] = next;
    manifest.raw.connectors = list;
    return { ok: true, commitMessage: `chore: ${secret ? 'bind' : 'unbind'} connector ${slug} credential` };
  });
}
