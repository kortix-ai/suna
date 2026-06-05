import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, chatThreads, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { loadSlackTokenForProject } from '../install-store';
import { updateMessage } from '../slack-api';
import { dispatchSlackEvent, pendingPickers, spawnAgentTurn } from './dispatch';
import { handleAskSubmit } from './questions';
import type { SlackEnvelope, SlackEvent, SlackInteractionPayload } from './types';

// Agent-emitted button click (carousel cards, actions blocks). Routes the
// click back into the thread as a synthesized follow-up so the agent's next
// turn picks up from the user's choice.
async function handleAgentClick(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const userId = payload.user?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !channelId || !userId || !threadTs) return;

  const label = (action.text?.text ?? action.action_id ?? '').trim();
  const value = (action.value ?? '').trim();

  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    text: `On it — picked *${label || action.action_id}*.`,
  });

  const [thread] = await db
    .select({ projectId: chatThreads.projectId })
    .from(chatThreads)
    .where(and(
      eq(chatThreads.platform, 'slack'),
      eq(chatThreads.workspaceId, teamId),
      eq(chatThreads.threadId, threadTs),
    ))
    .limit(1);
  if (!thread) return;

  const lines = [`[Button click] The user clicked *${label || action.action_id}*.`];
  if (action.action_id) lines.push(`action_id: \`${action.action_id}\``);
  if (value) lines.push(`value: \`${value}\``);
  lines.push('', 'Continue the turn based on this choice.');

  const event: SlackEvent = {
    type: 'message',
    user: userId,
    channel: channelId,
    text: lines.join('\n'),
    ts: messageTs,
    thread_ts: threadTs,
    team: teamId,
  };
  const envelope: SlackEnvelope = {
    type: 'event_callback',
    team_id: teamId,
    event,
  };
  await spawnAgentTurn(thread.projectId, envelope, event);
}

async function handleSwitchProject(payload: SlackInteractionPayload, rawValue: string): Promise<void> {
  let value: { p?: string; c?: string };
  try {
    value = JSON.parse(rawValue || '{}') as { p?: string; c?: string };
  } catch {
    return;
  }
  const projectId = value.p;
  const channelId = value.c ?? payload.channel?.id;
  const teamId = payload.team?.id ?? '';
  if (!projectId || !channelId || !teamId) return;

  const [install] = await db
    .select({ id: chatInstalls.installId })
    .from(chatInstalls)
    .where(and(
      eq(chatInstalls.platform, 'slack'),
      eq(chatInstalls.workspaceId, teamId),
      eq(chatInstalls.projectId, projectId),
    ))
    .limit(1);
  if (!install) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text: 'That project is no longer connected to this workspace.',
    });
    return;
  }

  await db
    .insert(chatChannelBindings)
    .values({ platform: 'slack', workspaceId: teamId, channelId, projectId, pickerTs: null })
    .onConflictDoUpdate({
      target: [chatChannelBindings.platform, chatChannelBindings.workspaceId, chatChannelBindings.channelId],
      set: { projectId, pickerTs: null },
    });

  const [p] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);

  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    replace_original: true,
    text: `Switched this channel to *${p?.name ?? 'project'}*.`,
  });
}

export async function respondViaUrl(url: string | undefined, body: unknown): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[slack-webhook] response_url POST failed', err);
  }
}

export async function handleBlockAction(payload: SlackInteractionPayload): Promise<void> {
  const action = payload.actions?.[0];
  if (!action?.action_id) return;

  if (action.action_id.startsWith('switch_project_')) {
    await handleSwitchProject(payload, action.value ?? '');
    return;
  }

  if (action.action_id === 'ask_submit') {
    await handleAskSubmit(payload, action.value ?? '');
    return;
  }

  if (action.action_id === 'value') {
    // No-op: live input/select element clicks before Submit. Slack still POSTs
    // here so we can preview/validate; we just don't act until ask_submit fires.
    return;
  }

  // Anything else is an agent-emitted button (typically inside a carousel card
  // or actions block from `slack send --blocks-file ...`). Route the click back
  // into the thread as a synthesized follow-up so the agent can continue.
  if (!action.action_id.startsWith('pick_project') && !action.action_id.startsWith('switch_project_')) {
    await handleAgentClick(payload, action);
    return;
  }

  if (!action.action_id.startsWith('pick_project')) return;
  let value: { k?: string; p?: string };
  try {
    value = JSON.parse(action.value ?? '{}') as { k?: string; p?: string };
  } catch {
    return;
  }
  const pickerId = value.k;
  const projectId = value.p;
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const pickerTs = payload.message?.ts ?? '';
  if (!pickerId || !projectId || !teamId || !channelId) return;

  const token = await loadSlackTokenForProject(projectId);

  const stillInstalled = await db
    .select({ id: chatInstalls.installId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, 'slack'),
        eq(chatInstalls.workspaceId, teamId),
        eq(chatInstalls.projectId, projectId),
      ),
    )
    .limit(1);
  if (stillInstalled.length === 0) {
    if (token && pickerTs) {
      await updateMessage(
        token,
        channelId,
        pickerTs,
        'That project is no longer connected here — @mention me again to pick another.',
      );
    }
    return;
  }

  await db
    .update(chatChannelBindings)
    .set({ projectId, pickerTs: null })
    .where(
      and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, teamId),
        eq(chatChannelBindings.channelId, channelId),
      ),
    );

  const [proj] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (token && pickerTs) {
    await updateMessage(
      token,
      channelId,
      pickerTs,
      `✓ Linked <#${channelId}> to *${proj?.name ?? 'project'}*.`,
    );
  }

  const pending = pendingPickers.get(pickerId);
  if (pending) {
    pendingPickers.delete(pickerId);
    await dispatchSlackEvent(projectId, pending.envelope);
  }
}
