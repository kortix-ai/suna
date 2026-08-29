/**
 * The durable, shared store for compiled pi worker runtimes.
 *
 * WHY IT EXISTS. The artifact lived only in `/tmp/kortix/compiled-boot` inside
 * the API container. That is not a store: the container has no mount, so every
 * deploy destroys it, and each replica keeps its own copy. Two consequences,
 * neither of them about speed (a cold compile measured 151 ms on
 * pi.kortix.com, a warm read 78 ms):
 *
 *  1. Session boot depended on GIT being reachable, because a miss recompiles
 *     from the mirror. On 2026-08-29 managed-git auth broke and
 *     `compile-agent-config` failed, so sessions booted with NO agent config.
 *  2. The push-time prebuild warmed one replica's disk. Any other replica, and
 *     every replica after a deploy, compiled again.
 *
 * WHY POSTGRES. It is the one store every environment already has, self-host
 * included — the API has no S3 client and self-host has no bucket. The
 * interface here is deliberately object-store shaped (get by key, put by key)
 * so an S3 driver can be added later without touching callers. Rows are ~900 KB
 * of minified JS, TOASTed and compressed.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { piRuntimeArtifacts } from '@kortix/db';
import { db } from '../shared/db';

/** Newest artifacts kept per (project, agent). Older ones are pruned on write. */
const RETAIN_PER_AGENT = 3;

export interface StoredPiRuntimeRecord {
  sha256: string;
  size: number;
  manifest: Record<string, unknown>;
  content: Buffer;
}

export interface PutPiRuntimeInput extends StoredPiRuntimeRecord {
  artifactKey: string;
  projectId: string;
  ref: string;
  sourceSha: string;
  agentName: string;
  workerBundleSha256: string;
}

/** The artifact for this exact key, or null. Never throws: a store that is
 * unavailable must degrade to a local compile, not fail the boot. */
export async function readStoredPiRuntimeArtifact(
  artifactKey: string,
): Promise<StoredPiRuntimeRecord | null> {
  try {
    const [row] = await db
      .select({
        sha256: piRuntimeArtifacts.sha256,
        size: piRuntimeArtifacts.size,
        manifest: piRuntimeArtifacts.manifest,
        content: piRuntimeArtifacts.content,
      })
      .from(piRuntimeArtifacts)
      .where(eq(piRuntimeArtifacts.artifactKey, artifactKey))
      .limit(1);
    if (!row?.content) return null;
    // Touch asynchronously: a read must not wait on bookkeeping.
    void db
      .update(piRuntimeArtifacts)
      .set({ lastUsedAt: new Date() })
      .where(eq(piRuntimeArtifacts.artifactKey, artifactKey))
      .catch(() => {});
    return {
      sha256: row.sha256,
      size: row.size,
      manifest: (row.manifest ?? {}) as Record<string, unknown>,
      content: Buffer.from(row.content),
    };
  } catch (error) {
    console.warn('[pi-runtime-store] read failed, falling back to a local compile', error);
    return null;
  }
}

/**
 * Publish an artifact. Idempotent on the key — two replicas compiling the same
 * (project, ref, sha, agent) produce byte-identical output, so the first write
 * wins and the second is a no-op rather than an error.
 */
export async function putStoredPiRuntimeArtifact(input: PutPiRuntimeInput): Promise<void> {
  try {
    await db
      .insert(piRuntimeArtifacts)
      .values({
        artifactKey: input.artifactKey,
        projectId: input.projectId,
        ref: input.ref,
        sourceSha: input.sourceSha,
        agentName: input.agentName,
        workerBundleSha256: input.workerBundleSha256,
        sha256: input.sha256,
        size: input.size,
        manifest: input.manifest,
        content: input.content,
      })
      .onConflictDoNothing();
    await pruneStoredPiRuntimeArtifacts(input.projectId, input.agentName);
  } catch (error) {
    // Publishing is an optimisation. A failure here costs a recompile on the
    // next boot; it must never fail the boot that produced the artifact.
    console.warn('[pi-runtime-store] publish failed', error);
  }
}

/** Keep the newest `RETAIN_PER_AGENT` rows for one (project, agent). */
export async function pruneStoredPiRuntimeArtifacts(
  projectId: string,
  agentName: string,
  retain = RETAIN_PER_AGENT,
): Promise<number> {
  const rows = await db
    .select({ artifactKey: piRuntimeArtifacts.artifactKey })
    .from(piRuntimeArtifacts)
    .where(
      and(
        eq(piRuntimeArtifacts.projectId, projectId),
        eq(piRuntimeArtifacts.agentName, agentName),
      ),
    )
    .orderBy(sql`${piRuntimeArtifacts.createdAt} desc`);
  const stale = rows.slice(retain).map((r) => r.artifactKey);
  if (stale.length === 0) return 0;
  await db.delete(piRuntimeArtifacts).where(inArray(piRuntimeArtifacts.artifactKey, stale));
  return stale.length;
}
