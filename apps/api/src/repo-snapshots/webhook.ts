/**
 * GitHub push ingestion for snapshot preparation.
 *
 * The payload is authenticated, then thrown away as a revision source: it says
 * only "something changed on this ref". The publisher re-resolves the tip from
 * GitHub, which is what makes duplicate deliveries, out-of-order deliveries and
 * force pushes converge on the same answer. Ordering by delivery arrival or by
 * commit timestamp would not.
 *
 * Repositories with no usable webhook — PAT-linked projects, and GitHub App
 * installations created while the App's manifest still declared
 * `hook_attributes.active: false` — are covered by the reconciliation pass in
 * `worker.ts` instead. Preparation is never left to the webhook alone.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { projects } from '@kortix/db';
import { and, ne, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { managedGithubAppConfig } from '../platform/services/managed-github-app';
import type { ProjectRow } from '../projects/lib/serializers';
import { recordedRepositoryIdSql } from './identity';
import { db } from '../shared/db';
import { prepareRefTip } from './prepare';
import { repoSnapshotWorkerEnabled } from './worker';

export interface GitHubPushEvent {
  ref?: string;
  deleted?: boolean;
  repository?: { id?: number; full_name?: string; default_branch?: string };
}

/** Every secret a delivery may legitimately be signed with. */
function candidateSecrets(): string[] {
  const secrets = [
    (config.KORTIX_REPO_SNAPSHOT_WEBHOOK_SECRET ?? '').trim(),
    (managedGithubAppConfig().webhookSecret ?? '').trim(),
  ];
  return secrets.filter((secret) => secret.length > 0);
}

/**
 * Constant-time `X-Hub-Signature-256` check against every configured secret.
 * Returns false when none is configured: an unsigned-by-anything deployment
 * must reject deliveries, never accept them.
 */
export function verifyGitHubWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secrets: string[] = candidateSecrets(),
): boolean {
  if (!signatureHeader || secrets.length === 0) return false;
  const signature = signatureHeader.trim().replace(/^sha256=/i, '');
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature.toLowerCase(), 'hex');
  return secrets.some((secret) => {
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}

/** Active projects bound to one GitHub repository id. */
async function projectsForRepository(repositoryId: string): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projects)
    .where(
      and(ne(projects.status, 'archived'), sql`${recordedRepositoryIdSql} = ${repositoryId}`),
    )
    .limit(50);
}

export type PushIngestResult =
  | { handled: true; ref: string; repositoryId: string; prepared: number; skipped: number }
  | { handled: false; reason: string };

/**
 * Handle one authenticated `push` delivery.
 *
 * A branch deletion clears the desired revision for that ref; it never leaves a
 * stale one behind. Non-branch refs (tags, notes) are ignored: sessions boot
 * from branches.
 */
export async function ingestGitHubPush(event: GitHubPushEvent): Promise<PushIngestResult> {
  if (!repoSnapshotWorkerEnabled()) return { handled: false, reason: 'snapshot storage is not configured' };
  const ref = (event.ref ?? '').trim();
  if (!ref.startsWith('refs/heads/')) return { handled: false, reason: `ignored ref ${ref || '(none)'}` };
  const repositoryId = String(event.repository?.id ?? '').trim();
  if (!/^[0-9]{1,20}$/.test(repositoryId)) return { handled: false, reason: 'payload has no repository id' };

  const matches = await projectsForRepository(repositoryId);
  if (matches.length === 0) return { handled: false, reason: 'no project is bound to this repository' };

  let prepared = 0;
  let skipped = 0;
  for (const project of matches) {
    const result = await prepareRefTip(project, ref, 'webhook');
    if (result.prepared) prepared += 1;
    else skipped += 1;
    // One prepared revision covers every project on this repository: the
    // artifact is repository-scoped. Stop after the first success.
    if (result.prepared) break;
  }
  logger.info('[repo-snapshot] push ingested', { repositoryId, ref, prepared, skipped });
  return { handled: true, ref, repositoryId, prepared, skipped };
}
