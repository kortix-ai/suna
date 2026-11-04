'use client';

import { useFeatureFlag, useProjectSpaces } from '@kortix/sdk/react';

import { AgentMark } from '../../internal/components/agent-mark';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { UiLink as Link } from '../../providers/ui-provider';
import { ChannelGlyph } from './channel-glyph';
import { agentLabel } from './space-timeline';

/**
 * The session header's way back to the space the session is filed in:
 * `# engineering /` or `<agent> /`, before the session's name. Drawn only with
 * `project_channels` on and once the space list knows the space; an archived
 * or hidden space draws nothing.
 */
export function SessionSpaceCrumb({ projectId, spaceId }: { projectId: string; spaceId: string }) {
  const channels = useFeatureFlag(projectId, 'project_channels').enabled;
  const spaces = useProjectSpaces(projectId, { enabled: channels });
  if (!channels) return null;
  const space = spaces.data?.find((candidate) => candidate.space_id === spaceId && !candidate.archived_at);
  if (!space) return null;
  const isChannel = space.kind === 'channel';
  const href = isChannel
    ? uiRoutes().channel(projectId, space.slug ?? '')
    : space.dm_agent_name
      ? uiRoutes().dm(projectId, space.dm_agent_name)
      : null;
  if (!href) return null;
  const label = isChannel ? (space.slug ?? space.name) : agentLabel(space.dm_agent_name ?? '');
  return (
    <>
      <Button asChild variant="ghost" className="text-foreground h-7 max-w-48 shrink-0 gap-1 rounded-md px-2 py-1">
        <Link href={href}>
          {isChannel ? (
            <ChannelGlyph visibility={space.visibility} className="size-3.5 shrink-0" />
          ) : (
            <AgentMark slug={space.dm_agent_name ?? ''} size={14} />
          )}
          <span className="truncate">{label}</span>
        </Link>
      </Button>
      <span aria-hidden className="text-muted-foreground shrink-0 text-sm select-none">
        /
      </span>
    </>
  );
}
