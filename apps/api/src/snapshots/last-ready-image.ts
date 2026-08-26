/**
 * "A session boot must never wait for an image build."
 *
 * THE INCIDENT. Every `self-host update` bumps the runtime fingerprint, which
 * changes the template identity and starts a template + project-image rebuild
 * (Essentia 2026-08-26: 14 min 11 s for `kortix-tpl-49493874d105`). Session
 * starts landing inside that window sat in `open-session:provisioning` for
 * 10–34 minutes: `ensureSandboxImage` either polled the in-flight build for up
 * to 12 minutes (`waitForProviderBuild`) or built the new identity inline.
 *
 * THE RULE. An image is a CACHE, not the truth. The daemon converges on this
 * deploy's runtime assets at boot and again on every resume/restart
 * (`apps/kortix-sandbox-agent-server/src/runtime-assets.ts`, poked by
 * `projects/lib/sandbox-runtime-refresh.ts`), so a box booted from the PREVIOUS
 * ready image ends up serving the same CLI, skills and daemon as one booted
 * from the new image — it just pays a convergence pass (seconds, up to ~1 min
 * when the pass installs a new OpenCode pin) instead of a 14-minute build.
 *
 * What that convergence does NOT cover is the base rootfs: interpreter
 * versions, apt packages, anything baked by the Dockerfile. So the fallback is
 * bounded — only images this template lineage actually shipped, only recent
 * ones — and it is never used for the FIRST build of a template, where there is
 * nothing to fall back to and blocking is the only honest answer.
 */

import { projectSnapshotBuilds } from '@kortix/db';
import { and, desc, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../shared/db';

/**
 * How far back a finished build may be and still be servable while a newer
 * identity bakes. Long enough to cover a weekend of failed rebuilds, short
 * enough that a months-old rootfs is never resurrected under a user.
 */
export const LAST_READY_IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How many historical images are probed. The provider read is not free. */
export const LAST_READY_IMAGE_CANDIDATE_LIMIT = 3;

export interface ReadyImage {
  snapshotName: string;
  contentHash: string | null;
}

/**
 * The ordered set of images that may serve a boot whose own identity is not
 * ready yet: the template row's recorded snapshot first (the one the row itself
 * calls last-known-good), then the most recent successful builds of the SAME
 * template lineage.
 *
 * Pure, so the ordering and the exclusions are testable without a database.
 * `identitySnapshotName` is always excluded — it is precisely the image that is
 * missing or still building, and offering it back would be a loop.
 */
export function lastReadyImageCandidates(input: {
  recordedSnapshotName: string | null;
  recordedContentHash?: string | null;
  history: readonly ReadyImage[];
  identitySnapshotName: string;
  limit?: number;
}): ReadyImage[] {
  const limit = input.limit ?? LAST_READY_IMAGE_CANDIDATE_LIMIT;
  const ordered: ReadyImage[] = [];
  if (input.recordedSnapshotName) {
    ordered.push({
      snapshotName: input.recordedSnapshotName,
      contentHash: input.recordedContentHash ?? null,
    });
  }
  ordered.push(...input.history);

  const seen = new Set<string>([input.identitySnapshotName]);
  const candidates: ReadyImage[] = [];
  for (const image of ordered) {
    if (!image.snapshotName || seen.has(image.snapshotName)) continue;
    seen.add(image.snapshotName);
    candidates.push(image);
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/**
 * Successful builds of one template lineage on one provider, newest first.
 *
 * Scoped by `branch` (which `openBuildLog` writes as the template slug) and by
 * the provider recorded in the build's metadata, so a project's OTHER template
 * — or the same identity built on a different provider, which would 404 on
 * create — can never be offered here. A shared platform template is looked up
 * across projects: its identity is global (`kortix-default-<hash>`) and the
 * build row is recorded under whichever project happened to trigger it.
 */
export async function readyImageHistory(input: {
  projectId: string;
  slug: string;
  provider: string;
  isShared: boolean;
  now?: Date;
  limit?: number;
}): Promise<ReadyImage[]> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - LAST_READY_IMAGE_MAX_AGE_MS);
  const rows = await db
    .select({
      snapshotName: projectSnapshotBuilds.snapshotName,
      contentHash: projectSnapshotBuilds.contentHash,
    })
    .from(projectSnapshotBuilds)
    .where(
      and(
        eq(projectSnapshotBuilds.status, 'ready'),
        eq(projectSnapshotBuilds.branch, input.slug),
        sql`${projectSnapshotBuilds.metadata}->>'provider' = ${input.provider}`,
        isNotNull(projectSnapshotBuilds.finishedAt),
        gte(projectSnapshotBuilds.finishedAt, cutoff),
        ...(input.isShared ? [] : [eq(projectSnapshotBuilds.projectId, input.projectId)]),
        ne(projectSnapshotBuilds.snapshotName, ''),
      ),
    )
    .orderBy(desc(projectSnapshotBuilds.finishedAt))
    .limit(input.limit ?? LAST_READY_IMAGE_CANDIDATE_LIMIT);
  return rows.map((row) => ({ snapshotName: row.snapshotName, contentHash: row.contentHash }));
}
