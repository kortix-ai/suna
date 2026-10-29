import type { ProjectSpace } from '@kortix/sdk';

/**
 * The channel's agents the project still offers, in the channel's order: the
 * first is the default a new thread starts on. Empty when the channel has no
 * agent list (then the project's default applies, as before).
 */
export function offeredChannelAgents(space: Pick<ProjectSpace, 'agents'> | null | undefined, offered: readonly { name: string }[]) {
  const names = new Set(offered.map((agent) => agent.name));
  return (space?.agents ?? []).filter((name) => names.has(name));
}


export { channelRunnableAgents } from '../../session/composer/composer-agent-access';
