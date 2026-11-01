import { accountMembers, artifactComments, artifactCommentThreads, artifactEvents, jobQueue, projects, sessionLifecycleCommands } from '@kortix/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Actor } from '../iam/actor';
import { db } from '../shared/db';
import { filterArtifactRecipients } from '../notifications/access';
import { loadProjectAgents, resolveUserIdentities } from '../projects/surface';
import { ArtifactCommentAuthorityError, authorizeArtifactCommentAgent } from './comment-authority';
import { resolveArtifactCommentSendTarget } from './comment-delivery';
import { artifactAgentMentionToken, artifactPersonMentionToken } from './comment-tokens';
import { unaddressedArtifactThreadIds } from './comment-routing-context';
import { ArtifactCommentError, listArtifactCommentThreads, type ArtifactCommentAccess } from './comments-service';
import { entryVersion, listVersions } from './service';
import { selectScreenshotSendBatch, screenshotTargetCapability, screenshotReferences, screenshotSizes, screenshotReferenceBudget } from './comment-screenshot-parts';
import { artifactCommentPrompt } from './comment-prompt';
import { config } from '../config';
import type { ArtifactCommentAnchor } from '@kortix/shared/artifact-comments';

export async function readArtifactCommentContext(access: ArtifactCommentAccess, actor: Actor, options: { version?: string; agent?: string }) {
  const artifact = access.artifact;
  const historical = options.version !== undefined;
  const [project] = await db.select().from(projects).where(and(eq(projects.projectId, artifact.projectId), eq(projects.accountId, artifact.accountId)));
  if (!project) throw new ArtifactCommentError(404, 'Project not found', 'not_found');
  const [threads, members, manifest, versions] = await Promise.all([
    listArtifactCommentThreads(access, 'all', options.version),
    db.select({ userId: accountMembers.userId }).from(accountMembers).where(eq(accountMembers.accountId, artifact.accountId)),
    loadProjectAgents(project, { rethrowReadErrors: true }),
    historical ? Promise.resolve([]) : listVersions(artifact),
  ]);
  const commitId = options.version ?? versions[0]?.id ?? null;
  const selectedEntry = await entryVersion(artifact, commitId ?? undefined);
  if (historical && !selectedEntry) throw new ArtifactCommentError(404, 'Artifact version not found', 'version_not_found');
  const ids = await filterArtifactRecipients(artifact, members.map((member) => member.userId));
  const identities = await resolveUserIdentities(ids);
  const emails = new Map<string, number>();
  for (const id of ids) {
    const email = identities.get(id)?.email?.trim().toLowerCase();
    if (email) emails.set(email, (emails.get(email) ?? 0) + 1);
  }
  const duplicates = new Set([...emails].filter(([, count]) => count > 1).map(([email]) => email));
  const people = ids.flatMap((userId) => {
    const identity = identities.get(userId);
    return identity?.exists === false ? [] : [{ user_id: userId, name: identity?.displayName?.trim() || identity?.email || 'Former user',
      avatar_url: identity?.avatarUrl ?? null, token: artifactPersonMentionToken(userId, identity?.email, duplicates) }];
  });
  let target: Awaited<ReturnType<typeof resolveArtifactCommentSendTarget>> | null = null;
  if (!historical && access.canComment) {
    try { target = await resolveArtifactCommentSendTarget(artifact, actor, access.sessionId, options.agent); }
    catch (error) { if (!(error instanceof ArtifactCommentAuthorityError)) throw error; }
  }
  const agents: Array<{ agent_name: string; name: string; session_id: string | null; token: string }> = [];
  if (access.canComment && !historical) {
    for (let index = 0; index < manifest.specs.length; index += 8) {
      const allowed = await Promise.all(manifest.specs.slice(index, index + 8).filter((agent) => agent.enabled).map(async (agent) => {
        try {
          const source = target?.session?.agentName === agent.name ? target.session : undefined;
          const authority = await authorizeArtifactCommentAgent(actor, project, agent.name, source);
          if (authority.callerSessionId !== access.sessionId) return null;
          return { agent_name: agent.name, name: agent.name, session_id: source && authority.canPromptExisting ? source.sessionId : null,
            token: artifactAgentMentionToken(agent.name) };
        } catch (error) { if (error instanceof ArtifactCommentAuthorityError) return null; throw error; }
      }));
      agents.push(...allowed.filter((agent): agent is NonNullable<typeof agent> => agent !== null));
    }
  }
  let sendThreadIds: string[] = [];
  if (target) {
    const [events, jobs, commands] = await Promise.all([
      db.select({ data: artifactEvents.data }).from(artifactEvents).where(and(eq(artifactEvents.artifactId, artifact.artifactId), eq(artifactEvents.type, 'sent_to_agent')))
        .orderBy(desc(artifactEvents.createdAt), desc(artifactEvents.eventId)),
      db.select({ status: jobQueue.status, payload: jobQueue.payload }).from(jobQueue).where(and(eq(jobQueue.artifactId, artifact.artifactId), eq(jobQueue.queue, 'artifact-comment-agents'))),
      db.select({ status: sessionLifecycleCommands.status, idempotencyKey: sessionLifecycleCommands.idempotencyKey, payload: sessionLifecycleCommands.payload })
        .from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.artifactId, artifact.artifactId)),
    ]);
    sendThreadIds = unaddressedArtifactThreadIds(threads, events, jobs, commands);
  }
  const commentCount = historical ? (await db.select({ count: sql<number>`count(*)::int` }).from(artifactComments)
    .innerJoin(artifactCommentThreads, eq(artifactCommentThreads.threadId, artifactComments.threadId))
    .where(and(eq(artifactCommentThreads.artifactId, artifact.artifactId), eq(artifactCommentThreads.projectId, artifact.projectId), isNull(artifactComments.deletedAt))))[0]!.count
    : threads.reduce((count, thread) => count + thread.comments.filter((comment) => !comment.deleted_at).length, 0);
  const images = threads.flatMap(thread => thread.comments.filter(comment => !comment.deleted_at && !!comment.screenshot_key));
  const capability = sendThreadIds.length && images.length ? await screenshotTargetCapability(artifact.projectId, target?.descriptor.kind === 'session' ? target.session?.sessionId : null) : { mayNeedImages: false };
  const imageCounts = new Map(threads.map(thread => [thread.thread_id, thread.comments.filter(comment => !comment.deleted_at && !!comment.screenshot_key).length]));
  const sizes = images.length ? await screenshotSizes(artifact.projectId, images.map(comment => comment.screenshot_key!)) : new Map<string, number>();
  const imageBytes = new Map(threads.map(thread => [thread.thread_id, screenshotReferenceBudget(screenshotReferences(artifact,
    thread.comments.map(comment => ({ commentId: comment.comment_id, screenshotKey: comment.screenshot_key, deletedAt: comment.deleted_at ? new Date(comment.deleted_at) : null })), ''), sizes)]));
  const textBytes = new Map(threads.map(thread => {
    const urls = new Map(screenshotReferences(artifact, thread.comments.map(comment => ({ commentId: comment.comment_id, screenshotKey: comment.screenshot_key,
      deletedAt: comment.deleted_at ? new Date(comment.deleted_at) : null })), config.KORTIX_URL).map(ref => [ref.filename.split('.')[0]!, ref.url]));
    const text = artifactCommentPrompt({ artifactId: artifact.artifactId, title: artifact.title, path: `${artifact.root}/${artifact.entry}`,
      version: selectedEntry ?? commitId ?? 'unknown' }, [{ thread_id: thread.thread_id, anchor: thread.anchor as ArtifactCommentAnchor,
      comments: thread.comments.map(comment => ({ body: comment.deleted_at ? '' : comment.body, author_user_id: comment.author_user_id,
        author_session_id: comment.author_session_id, ...(urls.has(comment.comment_id) ? { screenshot_url: urls.get(comment.comment_id)! } : {}) })) }]);
    return [thread.thread_id, Buffer.byteLength(JSON.stringify({ type: 'text', text })) + 1] as const;
  }));
  return { can_comment: !historical && !!access.canComment, can_moderate: !historical && !!access.viewer.manageAny,
    comment_count: commentCount,
    people, agents, send_target: target?.descriptor ?? null, ...selectScreenshotSendBatch(sendThreadIds, imageCounts, capability.mayNeedImages, imageBytes, textBytes),
    version: { commit_id: commitId, entry_version: selectedEntry } };
}
