// What the drive-sync routes keep on a session's sandbox row: the box that
// may call them, and the block uploads it planned (their paths are checked
// again at every block and at the commit).

import { sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';

/** The live session sandbox the drive-sync credential belongs to, or null. */
export async function liveSessionSandbox(input: { sessionId: string; projectId: string; accountId: string }) {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      projectId: sessionSandboxes.projectId,
      provider: sessionSandboxes.provider,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sessionId, input.sessionId),
        eq(sessionSandboxes.projectId, input.projectId),
        eq(sessionSandboxes.accountId, input.accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** session_sandboxes metadata: the block uploads this box planned, by upload id. */
const SYNC_UPLOADS_KEY = 'driveSyncUploads';
/** A plan never committed (a box that died mid-upload) is dropped after this. */
const UPLOAD_PLAN_TTL_MS = 24 * 60 * 60_000;

export interface UploadPlanRecord {
  driveId: string;
  paths: string[];
  at: string;
}

export function uploadPlans(metadata: unknown): Record<string, UploadPlanRecord> {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.[SYNC_UPLOADS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, UploadPlanRecord> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as Partial<UploadPlanRecord> | null;
    if (r && typeof r.driveId === 'string' && Array.isArray(r.paths) && r.paths.every((p) => typeof p === 'string')) {
      out[id] = { driveId: r.driveId, paths: r.paths as string[], at: typeof r.at === 'string' ? r.at : '' };
    }
  }
  return out;
}

/** Record a plan on the sandbox row, in one statement (concurrent plans keep each other), dropping expired ones. */
export async function rememberUploadPlan(sandboxId: string, uploadId: string, plan: UploadPlanRecord): Promise<void> {
  const live = sql`(
    SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      FROM jsonb_each(coalesce(${qualifiedColumn(sessionSandboxes.metadata)} -> ${SYNC_UPLOADS_KEY}, '{}'::jsonb)) e
     WHERE (e.value ->> 'at') > ${new Date(Date.now() - UPLOAD_PLAN_TTL_MS).toISOString()}
  )`;
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || jsonb_build_object(${SYNC_UPLOADS_KEY}::text, ${live} || ${JSON.stringify({ [uploadId]: plan })}::jsonb)`,
    })
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
}

export async function forgetUploadPlan(sandboxId: string, uploadId: string): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({ metadata: sql`${sessionSandboxes.metadata} #- ${`{${SYNC_UPLOADS_KEY},${uploadId}}`}::text[]` })
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
}
