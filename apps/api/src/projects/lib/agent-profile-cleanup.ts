import {
  agentKnowledgeSources,
  agentKnowledgeAssignments,
  agentProfileDrafts,
  agentProfileTestSessions,
  executorConnectionProfiles,
  projectSessions,
  projectSessionConnectorBindings,
  projects,
} from "@kortix/db";
import { and, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import { db } from "../../shared/db";
import { getSupabase } from "../../shared/supabase";
import { deleteSession } from "../session-lifecycle";
import { cleanupAgentChangeBranch } from "./agent-config-route-helpers";
import { AGENT_KNOWLEDGE_BUCKET } from "./agent-knowledge-sources";
import { withProjectGitAuth } from "./git";

const CLEANUP_BATCH = 50;

export async function cleanupExpiredAgentProfileArtifacts(
  now = new Date(),
): Promise<{
  drafts: number;
  sources: number;
  connectionProfiles: number;
  testSessions: number;
}> {
  const expiredTests = await db
    .select({
      grant: agentProfileTestSessions,
      sessionMetadata: projectSessions.metadata,
      project: projects,
    })
    .from(agentProfileTestSessions)
    .innerJoin(
      projectSessions,
      eq(projectSessions.sessionId, agentProfileTestSessions.sessionId),
    )
    .innerJoin(
      projects,
      eq(projects.projectId, agentProfileTestSessions.projectId),
    )
    .where(lt(agentProfileTestSessions.expiresAt, now))
    .limit(CLEANUP_BATCH);
  let testSessions = 0;
  for (const row of expiredTests) {
    const [deleted] = await db
      .delete(agentProfileTestSessions)
      .where(eq(agentProfileTestSessions.sessionId, row.grant.sessionId))
      .returning({ sessionId: agentProfileTestSessions.sessionId });
    if (!deleted) continue;
    testSessions += 1;
    await deleteSession({
      projectId: row.grant.projectId,
      sessionId: row.grant.sessionId,
      accountId: row.grant.accountId,
      userId: row.grant.createdBy,
      metadata: row.sessionMetadata,
    }).catch(() => undefined);
    await cleanupAgentChangeBranch(
      await withProjectGitAuth(row.project),
      row.grant.branchName,
    );
  }

  const expiredSources = await db
    .delete(agentKnowledgeSources)
    .where(
      and(
        lt(agentKnowledgeSources.expiresAt, now),
        isNull(agentKnowledgeSources.revokedAt),
        notExists(
          db
            .select({ sourceId: agentKnowledgeAssignments.sourceId })
            .from(agentKnowledgeAssignments)
            .where(
              and(
                eq(
                  agentKnowledgeAssignments.sourceId,
                  agentKnowledgeSources.sourceId,
                ),
                eq(agentKnowledgeAssignments.active, true),
              ),
            ),
        ),
      ),
    )
    .returning({ storagePath: agentKnowledgeSources.storagePath });
  const storagePaths = expiredSources.flatMap((source) =>
    source.storagePath ? [source.storagePath] : [],
  );
  if (storagePaths.length > 0) {
    await getSupabase()
      .storage.from(AGENT_KNOWLEDGE_BUCKET)
      .remove(storagePaths)
      .catch(() => {});
  }

  const expiredConnectionProfiles = await db
    .delete(executorConnectionProfiles)
    .where(
      and(
        eq(executorConnectionProfiles.isDefault, false),
        sql`case
          when ${executorConnectionProfiles.metadata}->>'agent_profile_draft_expires_at'
            ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
          then (${executorConnectionProfiles.metadata}->>'agent_profile_draft_expires_at')::timestamptz
          else null
        end < ${now.toISOString()}::timestamptz`,
        notExists(
          db
            .select({ sourceId: agentKnowledgeSources.sourceId })
            .from(agentKnowledgeSources)
            .where(
              eq(
                agentKnowledgeSources.connectorProfileId,
                executorConnectionProfiles.profileId,
              ),
            ),
        ),
        notExists(
          db
            .select({ sessionId: projectSessionConnectorBindings.sessionId })
            .from(projectSessionConnectorBindings)
            .where(
              eq(
                projectSessionConnectorBindings.profileId,
                executorConnectionProfiles.profileId,
              ),
            ),
        ),
        notExists(
          db
            .select({ draftId: agentProfileDrafts.draftId })
            .from(agentProfileDrafts)
            .where(
              and(
                eq(
                  agentProfileDrafts.projectId,
                  executorConnectionProfiles.projectId,
                ),
                sql`${agentProfileDrafts.sections}->'integrations' @> jsonb_build_array(jsonb_build_object('profile_id', ${executorConnectionProfiles.profileId}::text))`,
              ),
            ),
        ),
      ),
    )
    .returning({ profileId: executorConnectionProfiles.profileId });

  const expiredDrafts = await db
    .delete(agentProfileDrafts)
    .where(
      and(
        lt(agentProfileDrafts.expiresAt, now),
        isNull(agentProfileDrafts.branchName),
      ),
    )
    .returning({ draftId: agentProfileDrafts.draftId });

  return {
    drafts: expiredDrafts.length,
    sources: expiredSources.length,
    connectionProfiles: expiredConnectionProfiles.length,
    testSessions,
  };
}
