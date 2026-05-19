import type { Chat } from 'chat';
import { resolveChannel } from '../bindings';
import { spawnChannelSession } from '../spawn';
import { waitForSessionReady, sessionLink } from '../stream';
import { streamAgentResponse } from '../agent-bridge';
import { workspaceIdFromRaw } from '../workspace';

export function registerSlashHandler(bot: Chat) {
  bot.onSlashCommand(async (event) => {
    const workspaceId = workspaceIdFromRaw(event.raw);
    const resolved = await resolveChannel('slack', workspaceId, event.channel.id);
    if (!resolved) return;
    const commandName = event.command.replace(/^\//, '');
    const cmdSpec = resolved.spec.slashCommands.find((c) => c.name === commandName);
    if (!cmdSpec) return;

    const spawn = await spawnChannelSession({
      project: resolved.project,
      spec: resolved.spec,
      workspaceId,
      channelId: event.channel.id,
      threadId: event.channel.id,
      authorUserId: event.user?.userId ?? null,
      messageText: event.text,
      event: 'slash',
      slashCommand: { name: commandName, args: event.text },
    });
    if (spawn.status === 'failed') {
      await event.channel.post(`Couldn't start /${commandName}: ${spawn.error}`);
      return;
    }
    if (spawn.status === 'skipped') return;

    const sessionId = spawn.sessionId!;
    const ready = await waitForSessionReady(sessionId);
    if (ready.status === 'failed') {
      await event.channel.post(`Session failed: ${ready.error ?? 'unknown error'}`);
      return;
    }
    if (ready.status !== 'ready') {
      await event.channel.post(`Session is still spinning up. Tail it at ${sessionLink(sessionId)}.`);
      return;
    }

    await event.channel.post(
      streamAgentResponse(sessionId, resolved.project.accountId, event.text, resolved.spec.agent),
    );
  });
}
