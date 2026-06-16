import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  chatChannelBindings,
  chatInstalls,
  chatThreads,
  projects,
} from '@kortix/db';
import { db } from '../../shared/db';
import { deliverPromptToSession } from '../../projects/session-delivery';
import {
  loadSlackBotUserIdForProject,
  loadSlackTokenForProject,
} from '../install-store';
import {
  deleteMessage,
  getChannelName,
  postBlocks,
  postMessage,
} from '../slack-api';
import { PICKER_TTL_MS } from './app';
import { createOrJoinThreadSession, renderFollowUpPrompt } from './session';
import {
  deleteTurn,
  finalizeTurn,
  loadTurn,
  saveTurn,
  startTurn,
} from './turn';
import { stripMentions } from './util';
import type {
  EventClass,
  ProjectResolution,
  SlackEnvelope,
  SlackEvent,
} from './types';

export const pendingPickers = new Map<string, { envelope: SlackEnvelope; expiry: number }>();

export async function resolveOauthProject(
  teamId: string,
  channelId: string | undefined,
): Promise<ProjectResolution> {
  if (channelId) {
    const [binding] = await db
      .select({ projectId: chatChannelBindings.projectId })
      .from(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'slack'),
          eq(chatChannelBindings.workspaceId, teamId),
          eq(chatChannelBindings.channelId, channelId),
        ),
      )
      .limit(1);
    if (binding) {
      return binding.projectId
        ? { kind: 'project', projectId: binding.projectId }
        : { kind: 'pending' };
    }
  }

  const installs = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)));
  if (installs.length === 0) return { kind: 'none' };
  if (installs.length === 1) {
    const onlyProjectId = installs[0].projectId;
    if (channelId) {
      await db
        .insert(chatChannelBindings)
        .values({ platform: 'slack', workspaceId: teamId, channelId, projectId: onlyProjectId })
        .onConflictDoNothing({
          target: [chatChannelBindings.platform, chatChannelBindings.workspaceId, chatChannelBindings.channelId],
        });
    }
    return { kind: 'project', projectId: onlyProjectId };
  }
  return { kind: 'ambiguous', projectIds: installs.map((i) => i.projectId) };
}

export async function maybePostPicker(
  teamId: string,
  projectIds: string[],
  envelope: SlackEnvelope,
): Promise<void> {
  const event = envelope.event;
  if (!event || !event.channel || event.bot_id) return;
  const isMention = event.type === 'app_mention';
  const isDm = event.type === 'message' && event.channel_type === 'im' && !event.subtype;
  if (!isMention && !isDm) return;

  const channelId = event.channel;
  const claimed = await db
    .insert(chatChannelBindings)
    .values({ platform: 'slack', workspaceId: teamId, channelId, projectId: null })
    .onConflictDoNothing({
      target: [chatChannelBindings.platform, chatChannelBindings.workspaceId, chatChannelBindings.channelId],
    })
    .returning({ id: chatChannelBindings.bindingId });
  const isFreshClaim = claimed.length > 0;

  const token = await loadSlackTokenForProject(projectIds[0]);
  if (!token) return;

  if (!isFreshClaim) {
    const [existing] = await db
      .select({ pickerTs: chatChannelBindings.pickerTs, projectId: chatChannelBindings.projectId })
      .from(chatChannelBindings)
      .where(and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, teamId),
        eq(chatChannelBindings.channelId, channelId),
      ))
      .limit(1);
    if (existing?.projectId) return;
    if (existing?.pickerTs) {
      await deleteMessage(token, channelId, existing.pickerTs);
    }
  }

  const projectRows = await db
    .select({ projectId: projects.projectId, name: projects.name })
    .from(projects)
    .where(inArray(projects.projectId, projectIds));

  const pickerId = randomUUID();
  const channelName = isDm ? null : await getChannelName(token, channelId);
  const channelLabel = isDm ? 'this DM' : channelName ? `#${channelName}` : `<#${channelId}>`;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Which project should ${channelLabel} use?*\nAsked once — I'll remember it for this channel.`,
      },
    },
    {
      type: 'actions',
      elements: projectRows.map((row, idx) => ({
        type: 'button',
        text: { type: 'plain_text', text: row.name.slice(0, 75) },
        value: JSON.stringify({ k: pickerId, p: row.projectId }),
        action_id: `pick_project_${idx}`,
      })),
    },
  ];

  const now = Date.now();
  for (const [k, v] of pendingPickers) {
    if (v.expiry < now) pendingPickers.delete(k);
  }
  pendingPickers.set(pickerId, { envelope, expiry: now + PICKER_TTL_MS });

  const pickerTs = await postBlocks(
    token,
    channelId,
    `Which project should ${channelLabel} use?`,
    blocks,
    event.thread_ts ?? event.ts,
  );
  if (pickerTs) {
    await db
      .update(chatChannelBindings)
      .set({ pickerTs, channelName: channelName ?? null })
      .where(
        and(
          eq(chatChannelBindings.platform, 'slack'),
          eq(chatChannelBindings.workspaceId, teamId),
          eq(chatChannelBindings.channelId, channelId),
        ),
      );
  }
}

async function classifyEvent(
  teamId: string,
  event: SlackEvent,
  botUserId: string | null,
): Promise<EventClass> {
  if (event.type === 'app_mention') return 'mention';
  if (event.type !== 'message') return 'ignore';
  if (event.subtype) return 'ignore';
  if (botUserId && (event.text ?? '').includes(`<@${botUserId}>`)) return 'ignore';
  if (event.channel_type === 'im') return 'dm';
  if (event.thread_ts && (await threadIsOwned(teamId, event.thread_ts))) return 'follow_up';
  return 'ignore';
}

async function threadIsOwned(teamId: string, threadTs: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatThreads.threadRowId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'slack'),
        eq(chatThreads.workspaceId, teamId),
        eq(chatThreads.threadId, threadTs),
      ),
    )
    .limit(1);
  return !!row;
}

const CHANNEL_INTRO_FALLBACK = "Kortix is now connected to this channel. Mention @Kortix with a task to get started.";

async function postChannelIntro(projectId: string, channelId: string): Promise<void> {
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return;
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Kortix is connected to this channel', emoji: false },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          'Mention `@Kortix` with a task. The agent will read your repository, work in an isolated sandbox, and reply in-thread. Follow-up messages in the same thread continue the conversation.',
          '',
          'Run `/kortix help` to see available commands.',
        ].join('\n'),
      },
    },
  ];
  await postBlocks(token, channelId, CHANNEL_INTRO_FALLBACK, blocks);
}

export async function maybePostChannelIntro(teamId: string, event: SlackEvent): Promise<void> {
  if (!event.channel) return;
  const [install] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)))
    .limit(1);
  if (!install) return;
  const botUserId = await loadSlackBotUserIdForProject(install.projectId);
  if (!botUserId || event.user !== botUserId) return;
  await postChannelIntro(install.projectId, event.channel);
}

export async function dispatchSlackEvent(projectId: string, envelope: SlackEnvelope): Promise<void> {
  const event = envelope.event;
  if (!event) return;

  const teamId = envelope.team_id ?? event.team ?? '';
  const botUserId = await loadSlackBotUserIdForProject(projectId);

  if (
    event.type === 'member_joined_channel' &&
    botUserId &&
    event.user === botUserId &&
    event.channel
  ) {
    await postChannelIntro(projectId, event.channel);
    return;
  }

  if ((botUserId && event.user === botUserId) || event.bot_id) return;

  const eventClass = await classifyEvent(teamId, event, botUserId);
  if (eventClass === 'ignore') return;

  if (eventClass === 'mention' && !stripMentions(event.text ?? '')) {
    const token = await loadSlackTokenForProject(projectId);
    if (token && event.channel) {
      await postMessage(
        token,
        event.channel,
        "Hi! @mention me with a task and I'll get on it.",
        event.thread_ts ?? event.ts,
      );
    }
    return;
  }

  await spawnAgentTurn(projectId, envelope, event);
}

export async function spawnAgentTurn(
  projectId: string,
  envelope: SlackEnvelope,
  event: SlackEvent,
): Promise<void> {
  const teamId = envelope.team_id ?? event.team ?? '';
  const threadId = event.thread_ts ?? event.ts ?? '';

  let revived = false;
  if (teamId && threadId) {
    const [existing] = await db
      .select({ sessionId: chatThreads.sessionId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, 'slack'),
          eq(chatThreads.workspaceId, teamId),
          eq(chatThreads.threadId, threadId),
        ),
      )
      .limit(1);
    if (existing) {
      // A known thread maps PERMANENTLY to exactly one session. Route the message
      // into that session and NEVER create a second one — the session is durable
      // and resurrects its own sandbox (resume / reprovision) underneath; the
      // channel never touches the sandbox. The only stream-level decision here is
      // "is a turn already streaming?": if so, don't open a competing stream, just
      // hand the message to the running session.
      const inflight = await loadTurn(existing.sessionId);
      const turnInFlight = !!inflight && !inflight.finalized;

      const handle = turnInFlight
        ? null
        : await startTurn(projectId, teamId, event, 'On it');
      if (handle) {
        handle.sessionId = existing.sessionId;
        await saveTurn(handle);
      }
      const outcome = await deliverPromptToSession({
        sessionId: existing.sessionId,
        text: renderFollowUpPrompt(envelope, event),
      });

      if (outcome === 'delivered') {
        await db
          .update(chatThreads)
          .set({ lastMessageAt: new Date() })
          .where(
            and(
              eq(chatThreads.platform, 'slack'),
              eq(chatThreads.workspaceId, teamId),
              eq(chatThreads.threadId, threadId),
            ),
          );
        return;
      }

      if (outcome === 'pending') {
        // The session is ALIVE and owns this thread — it's just still coming up
        // (provisioning / waking from hibernation). KEEP the mapping; do NOT
        // recreate (recreating is exactly what orphaned the real session and
        // produced a second reply from "a session you can never find"). Let the
        // user know it's waking, only on a stream we own — never clobber an
        // in-flight turn's stream.
        if (handle) {
          await deleteTurn(existing.sessionId);
          await finalizeTurn(handle, {
            error: "Still waking this thread's session back up — send that again in a moment.",
          });
        }
        return;
      }

      if (outcome === 'failed') {
        // The session is in a genuine terminal error (provisioning failed). This is
        // the one honest failure — surface it; KEEP the mapping and never recreate
        // (a new session wouldn't fix a real fault, and silently recreating is what
        // we're eliminating). The thread stays bound to its session.
        if (handle) {
          await deleteTurn(existing.sessionId);
          await finalizeTurn(handle, {
            error: "This thread's session hit an error and couldn't start. Open it in Kortix to see what happened.",
          });
        }
        return;
      }

      // outcome === 'no-session': the durable projectSessions row itself is gone
      // (deleted; the chat_threads FK cascade should already have dropped this
      // mapping). With the 404-heal in deliverPromptToSession a stale OpenCode
      // root no longer masquerades as 'no-session', so this is now ONLY a truly
      // deleted session. Drop the stale mapping and recreate — atomically, below,
      // so the recreate can never shadow a live session.
      console.warn('[slack-webhook] thread mapped to a deleted session — replacing', {
        teamId,
        threadId,
        sessionId: existing.sessionId,
      });
      if (handle) await deleteTurn(existing.sessionId);
      revived = true;
      await db
        .delete(chatThreads)
        .where(
          and(
            eq(chatThreads.platform, 'slack'),
            eq(chatThreads.workspaceId, teamId),
            eq(chatThreads.threadId, threadId),
          ),
        );
    }
  }

  // No live mapping for this thread → create the session, or JOIN one that a
  // concurrent handler is creating this very moment. Single atomic create path.
  await createOrJoinThreadSession({ projectId, teamId, threadId, envelope, event, revived });
}
