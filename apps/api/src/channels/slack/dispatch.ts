import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  chatChannelBindings,
  chatInstalls,
  chatThreads,
  projects,
} from '@kortix/db';
import { db } from '../../shared/db';
import { createProjectSession, resolveGitTriggerActor } from '../../projects';
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
import {
  buildSlackTurnEnv,
  deleteStream,
  finalizeStream,
  saveStream,
  startTurnStream,
} from './streams';
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
      const handle = await startTurnStream(projectId, teamId, event, 'On it');
      if (handle) {
        handle.sessionId = existing.sessionId;
        await saveStream(handle);
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
      if (handle) {
        await deleteStream(existing.sessionId);
        await finalizeStream(handle, { error: "I couldn't reach the sandbox — try again." });
      }
      if (outcome === 'transient') return;
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

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  const userId = await resolveGitTriggerActor(project.accountId);
  if (!userId) {
    console.warn('[slack-webhook] no actor for project', projectId);
    return;
  }

  const handle = await startTurnStream(projectId, teamId, event, 'Spinning up a sandbox');

  const result = await createProjectSession({
    project,
    userId,
    body: {
      base_ref: project.defaultBranch,
      agent_name: 'default',
      initial_prompt: renderAgentPrompt(envelope, event, revived),
    },
    enforceAccountCap: false,
    metadata: {
      source: 'slack',
      slack: {
        team_id: teamId,
        channel: event.channel,
        user: event.user,
        thread_ts: threadId,
        event_type: event.type,
      },
    },
    // Sandbox-side env the slack skill references. The agent uses these to
    // talk back to the same thread without parsing IDs out of the prompt.
    extraEnvVars: buildSlackTurnEnv(teamId, event),
  });

  if (result.error) {
    console.error('[slack-webhook] createProjectSession failed', result.error.body);
    if (handle) {
      await finalizeStream(handle, { error: "I couldn't start up just now — try again in a moment." });
    }
    return;
  }

  if (result.row && handle) {
    handle.sessionId = result.row.sessionId;
    await saveStream(handle);
  }

  if (result.row && teamId && threadId) {
    try {
      await db
        .insert(chatThreads)
        .values({
          projectId,
          platform: 'slack',
          workspaceId: teamId,
          threadId,
          sessionId: result.row.sessionId,
        })
        .onConflictDoUpdate({
          target: [chatThreads.platform, chatThreads.workspaceId, chatThreads.threadId],
          set: { sessionId: result.row.sessionId, lastMessageAt: sql`now()` },
        });
    } catch (err) {
      console.warn('[slack-webhook] failed to record chat_threads row', err);
    }
  }
}

const TURN_INSTRUCTIONS = [
  'How to work:',
  '- **First, load the `kortix-slack` skill** via the `skill` tool. It is the canonical',
  '  reference for posting in Slack — covers step/send semantics, link syntax,',
  '  Block Kit answers, sources, tone, and gotchas. Do not skip it.',
  '- As you go, post a short progress checkpoint before each major step:',
  '    slack step "Reading the incident logs"',
  '  Keep them human and brief — a few per task, not one per command.',
  '- Attach inline context with mrkdwn links:',
  '    slack step "Reading the logs" --detail "Pulling from <https://datadog.example.com|Datadog>"',
  '  `--detail` is the subtitle under the new step. `<url|label>` becomes a real link.',
  '- When the PREVIOUS step finished with a result, surface it:',
  '    slack step "Drafting summary" --output "Found 3 incidents, 1 P0"',
  '  Add `--source URL|TITLE` (repeatable) to cite the URLs you used.',
  '- **Any time you would ask the user a question, use the built-in `question` tool — NEVER `slack send`.**',
  '  If your reply would contain a `?` or any "please tell me / choose / which one / what',
  '  would you like" phrasing, that is a question and it MUST go through `question`.',
  '  `slack send` is for the FINAL ANSWER only, never for prompts.',
  '  The `question` tool takes an `Array<QuestionInfo>` per opencode\'s schema — each',
  '  with { question, header, options[], multiple, custom }. On Slack turns the sandbox',
  '  automatically renders a Block Kit form (radio/checkboxes/text) in the same thread',
  '  and resumes the tool with the user\'s answers (`string[][]` — one array per question).',
  '  WRONG:  `slack send --blocks-file questions.json` (non-interactive — they can\'t reply!)',
  '  RIGHT:  call the `question` tool with one or more QuestionInfo entries.',
  '  Load the `kortix-slack` skill (`<asking-the-user>`) for the QuestionInfo schema + examples.',
  '- Deliver the answer as a rich Block Kit message whenever the response',
  '  benefits from structure (headers, sections, lists, links, bullets):',
  '    slack send --text "fallback summary" --blocks-file /tmp/answer.json',
  '  The `blocks` JSON follows the Block Kit schema (header, section with mrkdwn,',
  '  divider, context, image, actions). Plain text via `slack send "..."` is fine',
  '  for one-liners, but prefer blocks when there\'s real structure to convey.',
  '- One `slack send` per turn. It finalizes the live stream and can\'t be undone.',
].join('\n');

function renderFollowUpPrompt(envelope: SlackEnvelope, event: SlackEvent): string {
  const user = event.user ?? 'unknown';
  const text = event.text ?? '';
  return [
    `New message from ${user} in the same Slack thread:`,
    '',
    text,
    '',
    TURN_INSTRUCTIONS,
  ].join('\n');
}

function renderAgentPrompt(
  envelope: SlackEnvelope,
  event: SlackEvent,
  revived: boolean,
): string {
  const channel = event.channel ?? '?';
  const threadTs = event.thread_ts ?? event.ts ?? '';
  const user = event.user ?? 'unknown';
  const text = event.text ?? '';

  const lines: string[] = [];
  if (revived) {
    lines.push(
      'NOTE: This Slack thread had an earlier conversation, but that session',
      'has ended — you do NOT have its history. Open your reply by briefly',
      'saying you are picking the thread back up without the earlier context.',
      '',
    );
  }
  lines.push(
    "You're answering a message on Slack as a teammate.",
    '',
    `Workspace:  ${envelope.team_id ?? 'unknown'}`,
    `Channel:    ${channel}`,
    `User:       ${user}`,
  );
  if (threadTs) lines.push(`Thread ts:  ${threadTs}`);
  lines.push('', 'Message:', text, '', TURN_INSTRUCTIONS);
  return lines.join('\n');
}
