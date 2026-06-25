import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  chatChannelBindings,
  chatInstalls,
  chatThreads,
  projectSessions,
  projects,
} from '@kortix/db';
import { db } from '../../shared/db';
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
import { handleSlashCommand } from './commands';
import {
  createOrJoinThreadSession,
  deliverSlackFollowUpToSession,
  renderFollowUpPrompt,
} from './session';
import { postEphemeralLoginPrompt, resolveSlackActor } from './identity';
import { resolveProjectAutomationActor } from '../../projects/session-lifecycle';
import {
  deleteTurn,
  finalizeTurn,
  loadTurn,
  saveTurn,
  startTurn,
} from './turn';
import {
  claimInboundMessage,
  claimThreadErrorNotice,
  clearThreadErrorNotice,
  inboundMessageKey,
} from './dedup';
import { sessionWebUrl, stripMentions } from './util';
import { config } from '../../config';
import type {
  EventClass,
  ProjectResolution,
  SlackEnvelope,
  SlackEvent,
  SlashResponse,
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

  await postProjectPicker({
    teamId,
    projectIds,
    channelId: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    isDm,
    envelope,
  });
}

// Post the "which project should this conversation use?" picker — the SAME
// affordance, byte-for-byte, for channels (first @mention) and DMs (assistant
// open / first message). It guarantees a binding row exists FIRST (projectId
// null) so the pick handler, which UPDATEs by channelId, has a row to write
// into, and keeps at most one live picker per channel. `envelope`, when present,
// is replayed after the pick so the message that triggered it runs.
async function postProjectPicker(opts: {
  teamId: string;
  projectIds: string[];
  channelId: string;
  threadTs?: string;
  isDm: boolean;
  envelope?: SlackEnvelope;
}): Promise<void> {
  const { teamId, projectIds, channelId, threadTs, isDm, envelope } = opts;
  if (!channelId || projectIds.length === 0) return;

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
        text: `*Which project should ${channelLabel} use?*\nAsked once — I'll remember it for ${isDm ? 'this DM' : 'this channel'}.`,
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
  // Only register a replay when a message triggered the picker. On DM/assistant
  // open there's no message to replay — the pick just binds + confirms.
  if (envelope) {
    pendingPickers.set(pickerId, { envelope, expiry: now + PICKER_TTL_MS });
  }

  const pickerTs = await postBlocks(
    token,
    channelId,
    `Which project should ${channelLabel} use?`,
    blocks,
    threadTs,
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

// The AI-Assistant DM pane fires `assistant_thread_started` when a user opens
// (or starts a new) Kortix DM — the natural "which project is this connected
// to?" moment, exactly like inviting the bot to a channel. We run the IDENTICAL
// resolution the channel path uses (resolveOauthProject): one project →
// auto-bind silently, two+ unbound → the same project picker right in the
// assistant thread, already bound → nothing. So a DM user gets the exact same
// "choose your Kortix project" experience as a channel, without needing a slash
// command (which the Assistant pane can't run).
export async function handleAssistantThreadStarted(
  teamId: string,
  event: SlackEvent,
): Promise<void> {
  const channelId = event.assistant_thread?.channel_id;
  const threadTs = event.assistant_thread?.thread_ts;
  if (!teamId || !channelId) return;

  const resolution = await resolveOauthProject(teamId, channelId);
  if (resolution.kind === 'ambiguous') {
    await postProjectPicker({ teamId, projectIds: resolution.projectIds, channelId, threadTs, isDm: true });
  } else if (resolution.kind === 'pending') {
    const installs = await db
      .select({ projectId: chatInstalls.projectId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)));
    if (installs.length > 0) {
      await postProjectPicker({ teamId, projectIds: installs.map((i) => i.projectId), channelId, threadTs, isDm: true });
    }
  }
  // 'project' (bound, or auto-bound when there's exactly one) and 'none' →
  // no picker, identical to a channel that's already resolved.
}

// ── DM slash-command fallback ────────────────────────────────────────────────
// Slack does NOT run slash commands inside the AI-Assistant DM pane (or any
// message thread) — typing `/kortix switch` there is delivered to us as a plain
// `message.im` instead of a slash payload. So when a DM message IS a `/kortix …`
// command, run it through the EXACT same handler the real slash endpoint uses
// and post the reply right back into the DM. This makes the commands work in
// DMs even though Slack's native slash mechanism can't reach the assistant pane.
const DM_COMMAND_RE = /^\/(kortix(?:-dev)?)\b[ \t]*([\s\S]*)$/i;

async function postSlashResponseToChannel(
  token: string,
  channelId: string,
  threadTs: string | undefined,
  resp: SlashResponse,
): Promise<void> {
  if (resp.blocks && resp.blocks.length > 0) {
    await postBlocks(token, channelId, resp.text ?? 'Kortix', resp.blocks, threadTs);
  } else if (resp.text) {
    await postMessage(token, channelId, resp.text, threadTs);
  }
}

export async function maybeHandleDmCommand(
  teamId: string,
  event: SlackEvent,
  fallbackProjectId?: string,
): Promise<boolean> {
  if (event.type !== 'message' || event.channel_type !== 'im' || event.subtype || event.bot_id) {
    return false;
  }
  const channelId = event.channel;
  if (!channelId) return false;
  const match = (event.text ?? '').trim().match(DM_COMMAND_RE);
  if (!match) return false;

  const command = `/${match[1].toLowerCase()}`;
  const [subRaw, ...rest] = (match[2] ?? '').trim().split(/\s+/);
  const sub = (subRaw || 'help').toLowerCase();
  const arg = rest.join(' ').trim();
  const threadTs = event.thread_ts ?? event.ts;

  // A bot token to reply with: prefer the channel's bound project, else the BYO
  // project this webhook serves, else any workspace install.
  let tokenProjectId: string | null = null;
  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(and(
      eq(chatChannelBindings.platform, 'slack'),
      eq(chatChannelBindings.workspaceId, teamId),
      eq(chatChannelBindings.channelId, channelId),
    ))
    .limit(1);
  tokenProjectId = binding?.projectId ?? fallbackProjectId ?? null;
  if (!tokenProjectId) {
    const [install] = await db
      .select({ projectId: chatInstalls.projectId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)))
      .limit(1);
    tokenProjectId = install?.projectId ?? null;
  }
  if (!tokenProjectId) return true; // it WAS a command — just nothing to reply with
  const token = await loadSlackTokenForProject(tokenProjectId);
  if (!token) return true;

  // The Assistant pane has no 3s ACK window and no response_url, so a command
  // that normally defers (the agent list touches git) posts its result straight
  // into the DM instead.
  const deferredDeliver = (body: SlashResponse): Promise<void> =>
    postSlashResponseToChannel(token, channelId, threadTs, body);

  let resp: SlashResponse;
  try {
    resp = await handleSlashCommand(sub, arg, { teamId, channelId, slackUserId: event.user ?? '', command, deferredDeliver });
  } catch (err) {
    console.error('[slack-webhook] dm command failed', err);
    resp = { response_type: 'ephemeral', text: 'Something went wrong handling that command. Try again in a moment.' };
  }
  await postSlashResponseToChannel(token, channelId, threadTs, resp);
  return true;
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
          '`@`-mention Kortix with a task and an agent gets on it — working across your connected tools and replying right here in the thread. Follow-ups stay in the same conversation, with full context.',
          '',
          'Try something like:',
          '• `@Kortix summarize this thread and draft a reply to the customer`',
          '• `@Kortix pull last week’s signups, group them by source, and drop a CSV here`',
          '• `@Kortix put together a one-pager on our Q2 numbers`',
          '',
          'Run `/kortix help` to see commands.',
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

  // Exactly-once gate. ONE user message can arrive as several events (Slack
  // delivers a channel @mention as both `app_mention` and `message`), be retried
  // with a fresh event_id, and fan across replicas — but every delivery shares the
  // message's (team, channel, ts). Claim that identity atomically; if we lose, a
  // sibling delivery already owns this message, so we must NOT run it again.
  // This is what stops the "answered the same question 3×" class for good — a
  // redelivery that lands after the thread→session mapping exists would otherwise
  // be routed as a fresh follow-up and run the agent a second time.
  // (Button clicks synthesize their own turns via spawnAgentTurn directly and are
  // intentionally NOT gated here, so re-clicking an option still works.)
  const msgKey = inboundMessageKey(teamId, event);
  if (msgKey && !(await claimInboundMessage(msgKey))) return;

  await spawnAgentTurn(projectId, envelope, event);
}

export async function spawnAgentTurn(
  projectId: string,
  envelope: SlackEnvelope,
  event: SlackEvent,
): Promise<void> {
  const teamId = envelope.team_id ?? event.team ?? '';
  const threadId = event.thread_ts ?? event.ts ?? '';

  // Resolve who the agent runs AS. Gated by SLACK_REQUIRE_USER_IDENTITY:
  //  • ON  — every sender (first message OR follow-up, channel OR button click)
  //    must be linked to a Kortix account that is a member of this project's
  //    account. No live mapping → block and nudge to `/login`; never fall back
  //    to the owner (the impersonation this fixes).
  //  • OFF — legacy behavior: run as the account owner stand-in.
  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  let actorUserId: string;
  if (config.SLACK_REQUIRE_USER_IDENTITY) {
    const slackUserId = event.user ?? '';
    const actor = await resolveSlackActor(teamId, slackUserId, project.accountId);
    if ('reason' in actor) {
      await postEphemeralLoginPrompt({
        projectId,
        teamId,
        channel: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        slackUserId,
        reason: actor.reason,
      });
      return;
    }
    actorUserId = actor.userId;
  } else {
    const owner = await resolveProjectAutomationActor(project.accountId);
    if (!owner) {
      console.warn('[slack-webhook] no actor for project', projectId);
      return;
    }
    actorUserId = owner;
  }

  let revived = false;
  if (teamId && threadId) {
    const [existing] = await db
      .select({ sessionId: chatThreads.sessionId, createdBy: projectSessions.createdBy })
      .from(chatThreads)
      .innerJoin(projectSessions, eq(projectSessions.sessionId, chatThreads.sessionId))
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
      // Per-thread identity: a follow-up runs as the thread's original creator,
      // not whoever happens to be replying. The sandbox was already booted with
      // the creator's credentials; attribute the command to them too (fall back
      // to this validated sender if the row predates per-user identity).
      const outcome = await deliverSlackFollowUpToSession({
        sessionId: existing.sessionId,
        text: renderFollowUpPrompt(envelope, event),
        userId: existing.createdBy ?? actorUserId,
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
        //
        // But surface it ONCE. Because we keep the mapping, every later message in
        // the thread lands right back here (`session.status === 'failed'` is sticky)
        // and, unguarded, re-posts the identical line — the thread jammed on repeat.
        // The first failure claims a durable per-thread notice and posts it with a
        // direct link to open the session in Kortix; every later one just clears its
        // ⏳ ack and stays silent, so the thread isn't spammed forever.
        if (handle) {
          await deleteTurn(existing.sessionId);
          if (await claimThreadErrorNotice(teamId, threadId)) {
            const url = sessionWebUrl(config.FRONTEND_URL, projectId, existing.sessionId);
            await finalizeTurn(handle, {
              error: `This thread's session hit an error and couldn't start. <${url}|Open it in Kortix> to see what happened.`,
            });
          } else {
            await finalizeTurn(handle, {});
          }
        }
        return;
      }

      // outcome === 'no-session': the durable projectSessions row itself is gone
      // (deleted; the chat_threads FK cascade should already have dropped this
      // mapping). With the 404-heal in the shared lifecycle delivery path a stale OpenCode
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
      // Reviving onto a brand-new session — re-arm the failure notice so that
      // session's own first fault is reported, not swallowed by the dead one's claim.
      await clearThreadErrorNotice(teamId, threadId);
    }
  }

  // No live mapping for this thread → create the session, or JOIN one that a
  // concurrent handler is creating this very moment. Single atomic create path.
  await createOrJoinThreadSession({ projectId, teamId, threadId, envelope, event, revived, actorUserId });
}
