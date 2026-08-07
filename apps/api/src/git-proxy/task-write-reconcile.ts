import { projects } from '@kortix/db/schema';
import { eq } from 'drizzle-orm';
import type { TaskGitWriteReconciliationTarget } from '../projects/generated-state-store';
import { resolveProjectUpstream } from '../projects/lib/git';
import { db } from '../shared/db';
import { parseAdvertisedGitRefs } from './git-ref-advertisement';
import {
  buildTaskGitWriteReconcileBody,
  taskGitWriteMutationIsSettled,
} from './task-write-reconcile-protocol';

const MAX_ADVERTISEMENT_BYTES = 2 * 1024 * 1024;
const RECONCILE_TIMEOUT_MS = 10_000;

async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error('git ref advertisement has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ADVERTISEMENT_BYTES) throw new Error('git ref advertisement is too large');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reconcile the allowed branch and make the crashed request's compare-and-swap
 * impossible before returning true.
 *
 * If the requested new object reached the provider, an empty-pack receive-pack
 * completes the intended update. Otherwise, the server fences the old value:
 * it deletes an existing worker branch, or creates an absent worker branch at
 * another advertised object. The crashed old→new command can no longer match.
 */
export async function reconcileProjectTaskGitRemoteRef(
  target: TaskGitWriteReconciliationTarget,
): Promise<boolean> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, target.projectId))
    .limit(1);
  if (!project) throw new Error('project not found during task Git reconciliation');
  const upstream = await resolveProjectUpstream(project, 'write');
  if (!upstream?.url) throw new Error('git upstream unavailable during task Git reconciliation');

  const baseUrl = upstream.url.replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('git ref reconciliation timed out')),
    RECONCILE_TIMEOUT_MS,
  );
  const observe = async () => {
    const response = await fetch(`${baseUrl}/info/refs?service=git-upload-pack`, {
      method: 'GET',
      headers: upstream.headers,
      redirect: 'manual',
      signal: controller.signal,
      // @ts-ignore Bun extension: git pkt-lines must remain byte exact.
      decompress: false,
    });
    if (!response.ok) throw new Error(`git ref reconciliation returned ${response.status}`);
    return parseAdvertisedGitRefs(await readBounded(response));
  };
  const update = async (oldOid: string, newOid: string) => {
    const headers = new Headers(upstream.headers);
    headers.set('content-type', 'application/x-git-receive-pack-request');
    const response = await fetch(`${baseUrl}/git-receive-pack`, {
      method: 'POST',
      headers,
      body: buildTaskGitWriteReconcileBody(target, oldOid, newOid),
      redirect: 'manual',
      signal: controller.signal,
      // @ts-ignore Bun extensions: stream semantics and byte-exact pkt-lines.
      duplex: 'half',
      decompress: false,
    });
    // Consume the bounded status body before observing the ref again. The
    // response text is never logged because providers can echo ref details.
    await readBounded(response);
  };

  try {
    let refs = await observe();
    let current = refs.get(target.ref) ?? null;
    if (taskGitWriteMutationIsSettled(target, current)) return true;

    // First finish the intended update if its object upload completed.
    await update(target.oldOid, target.newOid);
    refs = await observe();
    current = refs.get(target.ref) ?? null;
    if (taskGitWriteMutationIsSettled(target, current)) return true;

    // The new object is unavailable. Change the old compare-and-swap value so
    // the abandoned request can never apply later.
    if (/^0+$/.test(target.oldOid)) {
      const fallbackOid = [...refs.entries()].find(([ref]) => ref !== target.ref)?.[1];
      if (!fallbackOid) return false;
      await update(target.oldOid, fallbackOid);
    } else {
      await update(target.oldOid, '0'.repeat(target.oldOid.length));
    }
    refs = await observe();
    current = refs.get(target.ref) ?? null;
    return taskGitWriteMutationIsSettled(target, current);
  } finally {
    clearTimeout(timeout);
  }
}
