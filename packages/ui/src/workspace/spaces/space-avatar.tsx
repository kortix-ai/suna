'use client';

import type { ProjectSpace } from '@kortix/sdk';

import { AgentMark, type AgentMarkSize } from '../../internal/components/agent-mark';
import { cn } from '../../lib/utils';
import { UserAvatar } from '../../primitives/user-avatar';
import { useUiViewer } from '../../providers/ui-provider';
import { isPersonalSpace, viewerDisplayName } from './space-identity';
import { useOtherPerson } from './space-people';

/**
 * Tile edge in px and the pixel mark inside it, per density. The edges match
 * `UserAvatar`'s boxes on this spacing scale (`size-6` ≈ 22px, `size-8` ≈ 29px,
 * `size-14` ≈ 52px), so a space, an agent and a person line up in one row.
 */
const SIZES = {
  sm: { tile: 22, mark: 14, person: 'sm' },
  md: { tile: 29, mark: 21, person: 'md' },
  xl: { tile: 52, mark: 42, person: 'xl' },
} as const satisfies Record<string, { tile: number; mark: AgentMarkSize; person: 'sm' | 'md' | 'xl' }>;

export type SpaceAvatarSize = keyof typeof SIZES;

/**
 * A space's face, in the agents' avatar system: a rounded square with the
 * generated pixel mark of its id (stable across a rename), in the same tones
 * an agent's mark takes. The person's own space shows the person's avatar, in
 * the same rounded square. Shapes: a person is round, an agent and a space
 * are rounded squares. Spaces have no uploaded image (nothing stores one).
 */
export function SpaceAvatar({
  space,
  size = 'md',
  personal,
  label,
  className,
  projectId,
}: {
  /** Null: the personal space before its first open. */
  space: (Pick<ProjectSpace, 'space_id' | 'kind' | 'dm_agent_name'> & Partial<ProjectSpace>) | null;
  size?: SpaceAvatarSize;
  /** Draw the personal space without its row (the sidebar's first row before `/chat` created it). */
  personal?: boolean;
  /** The hover hint: the space's name. */
  label: string;
  className?: string;
  /** Set: a two-person private space wears the other person's avatar (`useOtherPerson`). */
  projectId?: string;
}) {
  const viewer = useUiViewer();
  const s = SIZES[size];
  const other = useOtherPerson(projectId ?? '', projectId && space?.kind === 'channel' ? (space as ProjectSpace) : null);
  if (other) {
    return (
      <span aria-hidden data-slot="space-avatar" className={cn('inline-flex shrink-0 [&_[data-slot=avatar]]:rounded-md [&_[data-slot=avatar]]:after:rounded-md', className)}>
        <UserAvatar email="" name={other.name} avatarUrl={other.avatar_url} colorKey={other.user_id} size={s.person} />
      </span>
    );
  }
  if (personal || (space && isPersonalSpace(space))) {
    const meta = viewer?.metadata;
    const avatarUrl = typeof meta?.avatar_url === 'string' ? meta.avatar_url : null;
    return (
      <span aria-hidden data-slot="space-avatar" className={cn('inline-flex shrink-0 [&_[data-slot=avatar]]:rounded-md [&_[data-slot=avatar]]:after:rounded-md', className)}>
        <UserAvatar email={viewer?.email ?? ''} name={viewerDisplayName(viewer)} avatarUrl={avatarUrl} colorKey={viewer?.id} size={s.person} />
      </span>
    );
  }
  // A space wears its own mark, never an agent's: agents are its members.
  const slug = `space:${space?.space_id ?? label}`;
  return <AgentMark slug={slug} size={s.mark} tile={s.tile} label={label} className={cn(size !== 'sm' && 'rounded-md', className)} />;
}
