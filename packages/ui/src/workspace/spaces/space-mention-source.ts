'use client';

import type { ProjectSpace } from '@kortix/sdk';
import { useProjectConfig, useProjectSpaceMembers } from '@kortix/sdk/react';
import { createElement, useMemo } from 'react';

import { useTranslations } from '../../i18n';
import { useAccountMembers } from '../../internal/account-hub/use-account-members';
import { useBillingAccountId } from '../../internal/stores/billing-account-context';
import { useUiViewerId } from '../../providers/ui-provider';
import type { SpaceMentionSource } from '../../session/composer/menus/space-mentions';
import { SpaceAgentAsk } from './space-agent-ask';
import { agentLabel } from './space-timeline';

/** A display name as one `@` token, as the server reads it: `Ana Lima` → `ana-lima`. */
export function mentionSlug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9._@+-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The `@` menu of a space's composers: its people (the viewer left out) and
 * its agents, then the project's other agents (a channel only). Naming one of
 * those never adds it: the router hands work only to the space's agents, and
 * the composer asks after the send (`SpaceAgentAsk`). A person is mentioned by
 * email when the directory knows it, else by display name: the forms the
 * mention parser reads (`apps/api/src/projects/lib/space-posts.ts`).
 */
export function useSpaceMentionSource(projectId: string, space: ProjectSpace | undefined): SpaceMentionSource | null {
  const t = useTranslations('spaces.mentions');
  const viewerId = useUiViewerId();
  const config = useProjectConfig(projectId);
  const channel = space?.kind === 'channel' ? space : null;
  const members = useProjectSpaceMembers(projectId, channel?.space_id);
  const directory = useAccountMembers(useBillingAccountId());
  const roles = useTranslations('projectSelector.role');

  return useMemo(() => {
    if (!space) return null;
    const byId = new Map((directory.data ?? []).map((member) => [member.user_id, member]));
    const people = (members.data?.members ?? [])
      .filter((member) => member.user_id !== viewerId)
      .map((member) => {
        const known = byId.get(member.user_id);
        const role = known?.account_role;
        return {
          userId: member.user_id,
          name: member.name,
          // The forms the server's parser reads (`resolveMentions`): the email, else the display name as one token.
          token: known?.email ?? mentionSlug(member.name),
          secondary: known?.email ?? (role === 'owner' || role === 'admin' || role === 'member' ? roles(role) : null),
          avatarUrl: member.avatar_url,
        };
      });
    const configAgents = (config?.agents ?? []).filter((agent) => !agent.hidden && agent.enabled !== false && agent.mode !== 'subagent');
    const describe = (name: string) => configAgents.find((agent) => agent.name === name)?.description ?? null;
    const own = space.kind === 'dm' ? (space.dm_agent_name ? [space.dm_agent_name] : []) : (space.agents ?? []);
    // No agent list: the project's default answers here, so it reads as in the space.
    const projectDefault = config?.default_agent ?? null;
    const inSpace = own.length > 0 ? own : projectDefault ? [projectDefault] : [];
    const agents = [
      ...inSpace.map((name) => ({ name, label: agentLabel(name), description: describe(name), inSpace: true })),
      ...configAgents
        .filter((agent) => !inSpace.includes(agent.name))
        .map((agent) => ({ name: agent.name, label: agentLabel(agent.name), description: agent.description, inSpace: false })),
    ];
    const name = `#${space.slug ?? space.name}`;
    return {
      people,
      agents,
      labels: { people: t('people'), agents: t('agents'), addToSpace: t('addToSpace', { space: name }) },
      // A DM is not editable: its agent is the only one, and no other is offered.
      renderOutsideAsk: channel
        ? (agent: string, done: () => void) => createElement(SpaceAgentAsk, { projectId, space: channel, agent, onDone: done })
        : undefined,
    };
  }, [space, channel, members.data, directory.data, viewerId, config, t, roles, projectId]);
}
