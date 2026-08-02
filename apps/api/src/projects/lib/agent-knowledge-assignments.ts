import {
  agentKnowledgeAssignments,
  agentKnowledgeSources,
  agentProfileDrafts,
  changeRequests,
  executorConnectionProfiles,
} from '@kortix/db';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

function draftConnectorProfileIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const integrations = (value as Record<string, unknown>).integrations;
  if (!Array.isArray(integrations)) return [];
  return [
    ...new Set(
      integrations.flatMap((integration) => {
        if (!integration || typeof integration !== 'object' || Array.isArray(integration))
          return [];
        const profileId = (integration as Record<string, unknown>).profile_id;
        return typeof profileId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            profileId,
          )
          ? [profileId]
          : [];
      }),
    ),
  ];
}

function canonicalConnectorProfileIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (profileId): profileId is string =>
          typeof profileId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            profileId,
          ),
      ),
    ),
  ].sort();
}

function patchedPublicationMetadata(value: unknown, patch: Record<string, unknown>) {
  const metadata =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const profile =
    metadata.agent_profile &&
    typeof metadata.agent_profile === 'object' &&
    !Array.isArray(metadata.agent_profile)
      ? (metadata.agent_profile as Record<string, unknown>)
      : {};
  return { ...metadata, agent_profile: { ...profile, ...patch } };
}

export interface AgentKnowledgeReconcileResult {
  status: 'reconciled' | 'superseded';
  assigned: string[];
  missing: string[];
}

export async function reconcilePublishedAgentKnowledge(input: {
  accountId: string;
  projectId: string;
  agentName: string;
  sourceSlugs: string[];
  manifestRevision: string;
  changeRequestId?: string;
  draftRevision?: number;
  connectorProfileIds?: string[];
}): Promise<AgentKnowledgeReconcileResult> {
  const uniqueSlugs = [...new Set(input.sourceSlugs)].sort();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.projectId}:${input.agentName}`}, 0))`,
    );

    let changeRequestMetadata: unknown;
    if (input.changeRequestId) {
      const [publicationRequest] = await tx
        .select({ metadata: changeRequests.metadata, status: changeRequests.status })
        .from(changeRequests)
        .where(eq(changeRequests.crId, input.changeRequestId))
        .limit(1);
      if (!publicationRequest || publicationRequest.status !== 'merged') {
        throw new Error('Agent profile publication is not a merged change request.');
      }
      changeRequestMetadata = publicationRequest.metadata;
      const [latest] = await tx
        .select({ crId: changeRequests.crId })
        .from(changeRequests)
        .where(
          and(
            eq(changeRequests.projectId, input.projectId),
            eq(changeRequests.status, 'merged'),
            sql`${changeRequests.metadata}->'agent_profile'->>'agent_name' = ${input.agentName}`,
          ),
        )
        .orderBy(
          desc(changeRequests.mergedAt),
          desc(changeRequests.createdAt),
          desc(changeRequests.crId),
        )
        .limit(1);
      if (!latest || latest.crId !== input.changeRequestId) {
        await tx
          .update(changeRequests)
          .set({
            metadata: patchedPublicationMetadata(changeRequestMetadata, {
              knowledge_reconcile_superseded_at: new Date().toISOString(),
            }),
            updatedAt: new Date(),
          })
          .where(eq(changeRequests.crId, input.changeRequestId));
        return { status: 'superseded', assigned: [], missing: [] };
      }
    }

    const [profileDraft] =
      input.connectorProfileIds === undefined &&
      input.changeRequestId &&
      input.draftRevision !== undefined
        ? await tx
            .select({ sections: agentProfileDrafts.sections })
            .from(agentProfileDrafts)
            .where(
              and(
                eq(agentProfileDrafts.projectId, input.projectId),
                eq(agentProfileDrafts.agentName, input.agentName),
                eq(agentProfileDrafts.changeRequestId, input.changeRequestId),
                eq(agentProfileDrafts.revision, input.draftRevision),
              ),
            )
            .limit(1)
        : [];
    const publishedConnectorProfileIds =
      input.connectorProfileIds === undefined
        ? draftConnectorProfileIds(profileDraft?.sections)
        : canonicalConnectorProfileIds(input.connectorProfileIds);
    const sources =
      uniqueSlugs.length === 0
        ? []
        : await tx
            .select({
              sourceId: agentKnowledgeSources.sourceId,
              slug: agentKnowledgeSources.slug,
            })
            .from(agentKnowledgeSources)
            .where(
              and(
                eq(agentKnowledgeSources.accountId, input.accountId),
                eq(agentKnowledgeSources.projectId, input.projectId),
                eq(agentKnowledgeSources.agentName, input.agentName),
                inArray(agentKnowledgeSources.slug, uniqueSlugs),
                ne(agentKnowledgeSources.status, 'revoked'),
              ),
            );
    const now = new Date();
    const previousAssignments = await tx
      .select({ sourceId: agentKnowledgeAssignments.sourceId })
      .from(agentKnowledgeAssignments)
      .where(
        and(
          eq(agentKnowledgeAssignments.projectId, input.projectId),
          eq(agentKnowledgeAssignments.agentName, input.agentName),
          eq(agentKnowledgeAssignments.active, true),
        ),
      );
    await tx
      .update(agentKnowledgeAssignments)
      .set({ active: false, updatedAt: now })
      .where(
        and(
          eq(agentKnowledgeAssignments.projectId, input.projectId),
          eq(agentKnowledgeAssignments.agentName, input.agentName),
        ),
      );
    for (const source of sources) {
      await tx
        .update(agentKnowledgeSources)
        .set({ expiresAt: null, updatedAt: now })
        .where(eq(agentKnowledgeSources.sourceId, source.sourceId));
      await tx
        .insert(agentKnowledgeAssignments)
        .values({
          accountId: input.accountId,
          projectId: input.projectId,
          agentName: input.agentName,
          sourceId: source.sourceId,
          manifestRevision: input.manifestRevision,
          active: true,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            agentKnowledgeAssignments.projectId,
            agentKnowledgeAssignments.agentName,
            agentKnowledgeAssignments.sourceId,
          ],
          set: {
            manifestRevision: input.manifestRevision,
            active: true,
            updatedAt: now,
          },
        });
    }
    const assignedIds = new Set(sources.map((source) => source.sourceId));
    const removedIds = previousAssignments
      .map((assignment) => assignment.sourceId)
      .filter((sourceId) => !assignedIds.has(sourceId));
    if (removedIds.length > 0) {
      await tx
        .update(agentKnowledgeSources)
        .set({
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          updatedAt: now,
        })
        .where(
          and(
            inArray(agentKnowledgeSources.sourceId, removedIds),
            ne(agentKnowledgeSources.status, 'revoked'),
          ),
        );
    }
    if (publishedConnectorProfileIds.length > 0) {
      await tx
        .update(executorConnectionProfiles)
        .set({
          metadata: sql`${executorConnectionProfiles.metadata} - 'agent_profile_draft_agent' - 'agent_profile_draft_expires_at'`,
          updatedAt: now,
        })
        .where(
          and(
            eq(executorConnectionProfiles.accountId, input.accountId),
            eq(executorConnectionProfiles.projectId, input.projectId),
            inArray(executorConnectionProfiles.profileId, publishedConnectorProfileIds),
          ),
        );
    }
    if (input.changeRequestId) {
      const draftFilters = [
        eq(agentProfileDrafts.projectId, input.projectId),
        eq(agentProfileDrafts.agentName, input.agentName),
        eq(agentProfileDrafts.changeRequestId, input.changeRequestId),
      ];
      if (input.draftRevision !== undefined) {
        draftFilters.push(eq(agentProfileDrafts.revision, input.draftRevision));
      }
      await tx.delete(agentProfileDrafts).where(and(...draftFilters));
    }
    const assigned = sources.map((source) => source.slug).sort();
    const missing = uniqueSlugs.filter((slug) => !assigned.includes(slug));
    if (input.changeRequestId) {
      await tx
        .update(changeRequests)
        .set({
          metadata: patchedPublicationMetadata(changeRequestMetadata, {
            knowledge_reconciled_at: new Date().toISOString(),
            knowledge_assigned: assigned,
            knowledge_missing: missing,
            knowledge_reconcile_error: null,
          }),
          updatedAt: now,
        })
        .where(eq(changeRequests.crId, input.changeRequestId));
    }
    return {
      status: 'reconciled',
      assigned,
      missing,
    };
  });
}

interface AgentProfileKnowledgePublication {
  agentName: string;
  draftRevision: number;
  sourceSlugs: string[];
  connectorProfileIds?: string[];
}

function publicationFromMetadata(value: unknown): AgentProfileKnowledgePublication | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const profile = (value as Record<string, unknown>).agent_profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const metadata = profile as Record<string, unknown>;
  if (
    typeof metadata.agent_name !== 'string' ||
    typeof metadata.draft_revision !== 'number' ||
    !Number.isInteger(metadata.draft_revision) ||
    !Array.isArray(metadata.knowledge) ||
    !metadata.knowledge.every((slug) => typeof slug === 'string') ||
    (metadata.connector_profile_ids !== undefined &&
      (!Array.isArray(metadata.connector_profile_ids) ||
        canonicalConnectorProfileIds(metadata.connector_profile_ids).length !==
          metadata.connector_profile_ids.length))
  ) {
    return null;
  }
  return {
    agentName: metadata.agent_name,
    draftRevision: metadata.draft_revision as number,
    sourceSlugs: [...new Set(metadata.knowledge as string[])].sort(),
    connectorProfileIds:
      metadata.connector_profile_ids === undefined
        ? undefined
        : canonicalConnectorProfileIds(metadata.connector_profile_ids),
  };
}

async function patchPublicationMetadata(
  changeRequestId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const [row] = await db
    .select({ metadata: changeRequests.metadata })
    .from(changeRequests)
    .where(eq(changeRequests.crId, changeRequestId))
    .limit(1);
  if (!row) return;
  await db
    .update(changeRequests)
    .set({
      metadata: patchedPublicationMetadata(row.metadata, patch),
      updatedAt: new Date(),
    })
    .where(and(eq(changeRequests.crId, changeRequestId), eq(changeRequests.status, 'merged')));
}

export async function retryPendingAgentProfileKnowledgeReconciliations(
  limit = 20,
): Promise<{ reconciled: number; skipped: number; failed: number }> {
  const candidates = await db
    .select({
      crId: changeRequests.crId,
      accountId: changeRequests.accountId,
      projectId: changeRequests.projectId,
      metadata: changeRequests.metadata,
      mergeCommitSha: changeRequests.mergeCommitSha,
    })
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.status, 'merged'),
        sql`jsonb_typeof(${changeRequests.metadata}->'agent_profile'->'knowledge') = 'array'`,
        sql`${changeRequests.metadata}->'agent_profile'->>'knowledge_reconciled_at' is null`,
        sql`${changeRequests.metadata}->'agent_profile'->>'knowledge_reconcile_superseded_at' is null`,
        sql`${changeRequests.metadata}->'agent_profile'->>'knowledge_reconcile_skipped_at' is null`,
      ),
    )
    .orderBy(
      asc(
        sql`coalesce(${changeRequests.metadata}->'agent_profile'->>'knowledge_reconcile_attempted_at', '')`,
      ),
      desc(changeRequests.mergedAt),
      desc(changeRequests.createdAt),
    )
    .limit(Math.max(1, Math.min(limit, 100)));

  let reconciled = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const publication = publicationFromMetadata(candidate.metadata);
    if (!publication || !candidate.mergeCommitSha) {
      skipped += 1;
      await patchPublicationMetadata(candidate.crId, {
        knowledge_reconcile_skipped_at: new Date().toISOString(),
        knowledge_reconcile_skip_reason: 'invalid_publication_metadata',
      });
      continue;
    }

    const [latest] = await db
      .select({ crId: changeRequests.crId })
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.projectId, candidate.projectId),
          eq(changeRequests.status, 'merged'),
          sql`${changeRequests.metadata}->'agent_profile'->>'agent_name' = ${publication.agentName}`,
        ),
      )
      .orderBy(
        desc(changeRequests.mergedAt),
        desc(changeRequests.createdAt),
        desc(changeRequests.crId),
      )
      .limit(1);
    if (!latest || latest.crId !== candidate.crId) {
      skipped += 1;
      await patchPublicationMetadata(candidate.crId, {
        knowledge_reconcile_superseded_at: new Date().toISOString(),
      });
      continue;
    }

    try {
      const result = await reconcilePublishedAgentKnowledge({
        accountId: candidate.accountId,
        projectId: candidate.projectId,
        agentName: publication.agentName,
        sourceSlugs: publication.sourceSlugs,
        manifestRevision: candidate.mergeCommitSha,
        changeRequestId: candidate.crId,
        draftRevision: publication.draftRevision,
        connectorProfileIds: publication.connectorProfileIds,
      });
      if (result.status === 'reconciled') reconciled += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await patchPublicationMetadata(candidate.crId, {
        knowledge_reconcile_attempted_at: new Date().toISOString(),
        knowledge_reconcile_error: message,
      }).catch((metadataError) =>
        console.warn(
          '[agent-profile] knowledge reconciliation retry metadata failed',
          candidate.projectId,
          publication.agentName,
          metadataError instanceof Error ? metadataError.message : metadataError,
        ),
      );
      console.warn(
        '[agent-profile] knowledge reconciliation retry failed',
        candidate.projectId,
        publication.agentName,
        message,
      );
    }
  }
  return { reconciled, skipped, failed };
}
