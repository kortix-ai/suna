/**
 * The `change_request` source (`lib/runtime-triggers.ts`): a merged change
 * request fires every enabled trigger whose filter matches it, runtime rows and
 * kortix.yaml `type: change_request` entries alike (both are
 * `project_trigger_runtime` rows: reconcile catalogs the manifest ones). The
 * merge route calls this after the merge is durable; it never fails the merge.
 */
import { projectTriggerRuntime } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { recordTriggerRun, triggerRunFromFire } from '../trigger-execution-store';
import type { GitTriggerSpec } from '../triggers';
import { type MergedChangeRequest, changeRequestMatches } from './runtime-triggers';
import type { ProjectRow } from './serializers';
import { raiseTriggerAlert } from './trigger-alerts';
import { fireGitTrigger, markGitTriggerAttemptFailed, markGitTriggerFired } from './trigger-fire';
import { renderPromptTemplate } from './trigger-payload';
import { automaticFirePauseReason } from './trigger-scheduler-state';

/** Fire the triggers each merged request matches. Returns the fires that reached a session. Never throws. */
export async function fireChangeRequestMergedTriggers(
  project: ProjectRow,
  merged: readonly MergedChangeRequest[],
): Promise<number> {
  try {
    if (merged.length === 0) return 0;
    const rows = await db
      .select({ slug: projectTriggerRuntime.slug, spec: projectTriggerRuntime.scheduleSpec })
      .from(projectTriggerRuntime)
      .where(
        and(
          eq(projectTriggerRuntime.projectId, project.projectId),
          eq(projectTriggerRuntime.triggerType, 'change_request'),
          eq(projectTriggerRuntime.enabled, true),
          isNull(projectTriggerRuntime.autoPausedAt),
        ),
      );
    if (rows.length === 0) return 0;
    const paused = await automaticFirePauseReason(project);
    let reached = 0;
    for (const cr of merged) {
      for (const row of rows) {
        const spec = row.spec as unknown as GitTriggerSpec;
        if (!spec || !changeRequestMatches(spec, cr)) continue;
        if (await fireOne(project, spec, cr, paused)) reached += 1;
      }
    }
    return reached;
  } catch (error) {
    logger.warn('[triggers] change request fire failed', {
      projectId: project.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function fireOne(project: ProjectRow, spec: GitTriggerSpec, cr: MergedChangeRequest, paused: string | null): Promise<boolean> {
  const now = new Date();
  const payload = {
    change_request: cr,
    // A kortix.yaml slug has no `.`; a runtime id does (`trigger.<hex>`).
    trigger: { slug: spec.slug, type: spec.type, kind: spec.slug.includes('.') ? 'runtime' : 'declared' },
    fired_at: now.toISOString(),
  };
  const run = { projectId: project.projectId, slug: spec.slug, source: 'change_request' as const, spec, payload, now };
  // A paused project or account records the merge as a skipped run, like a paused webhook.
  if (paused) {
    await recordTriggerRun({ ...run, status: 'skipped', error: paused });
    return false;
  }
  const result = await fireGitTrigger({
    spec,
    project,
    payload,
    renderedPrompt: renderPromptTemplate(spec.promptTemplate, payload),
    source: 'change_request',
    // One merge fires one trigger once, however often the hook is retried.
    idempotencyKey: `trigger:change_request:${project.projectId}:${spec.slug}:${cr.cr_id}`,
  }).catch((error: unknown) => ({ status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }));
  await recordTriggerRun({ ...run, ...triggerRunFromFire(result) });
  if (result.status === 'fired' || result.status === 'queued') {
    if (!('deduped' in result && result.deduped)) {
      await markGitTriggerFired(project.projectId, spec.slug, new Date(), 'fired', { endsAlert: result.status === 'fired' });
    }
    return true;
  }
  if (result.status === 'failed') {
    const error = result.error ?? 'trigger fire failed';
    await markGitTriggerAttemptFailed(project.projectId, spec.slug, new Date(), error).catch(() => {});
    await raiseTriggerAlert({ projectId: project.projectId, accountId: project.accountId, slug: spec.slug, source: 'fire', error });
  }
  return false;
}
