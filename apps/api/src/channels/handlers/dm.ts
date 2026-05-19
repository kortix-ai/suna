import type { Chat } from 'chat';
import { resolveChannel } from '../bindings';
import { spawnChannelSession } from '../spawn';
import { waitForSessionReady, sessionLink } from '../stream';
import { streamAgentResponse } from '../agent-bridge';
import { workspaceIdFromRaw } from '../workspace';

export function registerDmHandler(bot: Chat) {
  bot.onDirectMessage(async (thread, message) => {
    const workspaceId = workspaceIdFromRaw(message.raw);
    const resolved = await resolveChannel('slack', workspaceId, thread.channelId);
    if (!resolved) return;

    await thread.subscribe();
    await thread.startTyping();

    const spawn = await spawnChannelSession({
      project: resolved.project,
      spec: resolved.spec,
      workspaceId,
      channelId: thread.channelId,
      threadId: thread.id,
      authorUserId: message.author?.userId ?? null,
      messageText: message.text,
      event: 'dm',
    });
    if (spawn.status === 'failed') {
      await thread.post(`Couldn't start: ${spawn.error}`);
      return;
    }
    if (spawn.status === 'skipped') return;

    const sessionId = spawn.sessionId!;
    const ready = await waitForSessionReady(sessionId);
    if (ready.status === 'failed') {
      await thread.post(`Session failed: ${ready.error ?? 'unknown error'}`);
      return;
    }
    if (ready.status !== 'ready') {
      await thread.post(`Session is still spinning up. Tail it at ${sessionLink(sessionId)}.`);
      return;
    }

    await thread.post(
      streamAgentResponse(sessionId, resolved.project.accountId, message.text, resolved.spec.agent),
    );
  });
}
