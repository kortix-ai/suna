import type { Project } from '@kortix/db';
import { chatThreads } from '@kortix/db';
import { db } from '../shared/db';
import { createProjectSession, resolveGitTriggerActor } from '../projects';
import type { ChannelEvent, ChannelSpec } from './manifest';
import { renderPromptPrefix } from './render';

interface SpawnInput {
  project: Project;
  spec: ChannelSpec;
  workspaceId: string;
  channelId: string;
  threadId: string;
  authorUserId: string | null;
  messageText: string;
  event: ChannelEvent;
  slashCommand?: { name: string; args: string };
}

export interface SpawnResult {
  status: 'fired' | 'skipped' | 'failed';
  sessionId?: string;
  reason?: string;
  error?: string;
}

export async function spawnChannelSession(input: SpawnInput): Promise<SpawnResult> {
  const { project, spec, workspaceId, event } = input;

  if (!spec.events.includes(event)) {
    return { status: 'skipped', reason: `event "${event}" not enabled for channel "${spec.slug}"` };
  }

  const renderedPrompt = renderPromptPrefix(spec.promptPrefix, {
    project,
    spec,
    event,
    messageText: input.messageText,
    slashCommand: input.slashCommand,
  });

  const actor = await resolveGitTriggerActor(project.accountId);
  if (!actor) {
    return { status: 'failed', error: 'No account owner available to own the session' };
  }

  const sessionResult = await createProjectSession({
    project,
    userId: actor,
    enforceAccountCap: false,
    body: {
      agent_name: spec.agent,
      initial_prompt: renderedPrompt,
      metadata: {
        channel_source: spec.platform,
        channel_slug: spec.slug,
        channel_event: event,
        channel_thread_id: input.threadId,
      },
    },
    metadata: {
      channel_source: spec.platform,
      channel_slug: spec.slug,
      channel_event: event,
      channel_workspace_id: workspaceId,
      channel_thread_id: input.threadId,
      channel_user_id: input.authorUserId,
      ...(input.slashCommand ? { channel_slash: input.slashCommand.name } : {}),
    },
  });

  if (sessionResult.error) {
    return {
      status: 'failed',
      error: String(sessionResult.error.body.error ?? 'Failed to create channel session'),
    };
  }

  const sessionId = sessionResult.row!.sessionId;

  await db
    .insert(chatThreads)
    .values({
      platform: spec.platform,
      workspaceId,
      channelId: input.channelId,
      threadId: input.threadId,
      projectId: project.projectId,
      sessionId,
      channelSlug: spec.slug,
      openedBy: input.authorUserId,
      lastMessageAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [chatThreads.platform, chatThreads.workspaceId, chatThreads.threadId],
      set: { sessionId, lastMessageAt: new Date() },
    });

  return { status: 'fired', sessionId };
}
