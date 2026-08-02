import {
  agentKnowledgeAssignments,
  agentKnowledgeSources,
  agentProfileDrafts,
  executorConnectionProfiles,
} from "@kortix/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../shared/db";

function draftConnectorProfileIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const integrations = (value as Record<string, unknown>).integrations;
  if (!Array.isArray(integrations)) return [];
  return [
    ...new Set(
      integrations.flatMap((integration) => {
        if (
          !integration ||
          typeof integration !== "object" ||
          Array.isArray(integration)
        )
          return [];
        const profileId = (integration as Record<string, unknown>).profile_id;
        return typeof profileId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            profileId,
          )
          ? [profileId]
          : [];
      }),
    ),
  ];
}

export async function reconcilePublishedAgentKnowledge(input: {
  accountId: string;
  projectId: string;
  agentName: string;
  sourceSlugs: string[];
  manifestRevision: string;
  changeRequestId?: string;
}): Promise<{ assigned: string[]; missing: string[] }> {
  const uniqueSlugs = [...new Set(input.sourceSlugs)].sort();
  return db.transaction(async (tx) => {
    const [profileDraft] = input.changeRequestId
      ? await tx
          .select({ sections: agentProfileDrafts.sections })
          .from(agentProfileDrafts)
          .where(
            and(
              eq(agentProfileDrafts.projectId, input.projectId),
              eq(agentProfileDrafts.agentName, input.agentName),
              eq(agentProfileDrafts.changeRequestId, input.changeRequestId),
            ),
          )
          .limit(1)
      : [];
    const publishedConnectorProfileIds = draftConnectorProfileIds(
      profileDraft?.sections,
    );
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
                ne(agentKnowledgeSources.status, "revoked"),
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
            ne(agentKnowledgeSources.status, "revoked"),
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
            inArray(
              executorConnectionProfiles.profileId,
              publishedConnectorProfileIds,
            ),
          ),
        );
    }
    if (input.changeRequestId) {
      await tx
        .delete(agentProfileDrafts)
        .where(
          and(
            eq(agentProfileDrafts.projectId, input.projectId),
            eq(agentProfileDrafts.agentName, input.agentName),
            eq(agentProfileDrafts.changeRequestId, input.changeRequestId),
          ),
        );
    }
    const assigned = sources.map((source) => source.slug).sort();
    return {
      assigned,
      missing: uniqueSlugs.filter((slug) => !assigned.includes(slug)),
    };
  });
}
