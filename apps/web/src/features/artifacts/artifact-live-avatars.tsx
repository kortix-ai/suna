'use client';

import type { ArtifactLiveState } from '@kortix/sdk/react';
import { cn } from '@kortix/ui';
import { AgentMark } from '@kortix/ui/internal/components/agent-mark';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@kortix/ui/field';
import Hint from '@kortix/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@kortix/ui/popover';
import { Switch } from '@kortix/ui/switch';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { UsersIcon } from '@phosphor-icons/react';
import { useId, useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { LIVE_RING } from './artifact-live-colors';
import { liveStack, type LiveMember, type LiveMembers } from './artifact-live-logic';
import { useLiveStatusLabel } from './artifact-live-presence';
import { AVATAR_SM_EDGE } from './artifact-meta';

/** The color ring that ties a face to its cursor; the offset keeps overlapping faces apart. */
const ringOf = (member: LiveMember) =>
  cn('ring-offset-background ring-2 ring-offset-1', LIVE_RING[member.color]);

function LiveFace({ member, hint }: { member: LiveMember; hint?: string }) {
  return member.kind === 'session' ? (
    // The agent's pixel mark is its face: a person's tile shows a photo or initials.
    <AgentMark
      slug={member.name}
      label={hint ?? member.name}
      tile={AVATAR_SM_EDGE}
      className={ringOf(member)}
    />
  ) : (
    <UserAvatar
      name={member.name}
      email=""
      avatarUrl={member.avatarUrl}
      size="sm"
      hint={hint}
      className={ringOf(member)}
    />
  );
}

/**
 * Who is on the Artifact now, in the header: one face per person and per agent
 * session, in their live color, the viewer left out. At most four, then "+N";
 * a narrow header shows the count only. The popover lists everyone, the viewer
 * marked "You", and holds "Hide my cursor". Faces dim while the connection is
 * not live. Renders nothing while the viewer is alone.
 */
export function ArtifactLiveAvatars({
  members,
  status,
  compact,
  cursorHidden,
  onCursorHiddenChange,
}: {
  members: LiveMembers;
  status: ArtifactLiveState['status'];
  compact: boolean;
  cursorHidden: boolean;
  onCursorHiddenChange: (hidden: boolean) => void;
}) {
  const t = useTranslations('artifacts.live');
  const statusLabel = useLiveStatusLabel();
  const [open, setOpen] = useState(false);
  const switchId = useId();
  const { others, you } = members;
  if (!others.length) return null;
  const { shown, more } = liveStack(others);
  const live = status === 'live';
  const names = others.map((member) => member.name).join(', ');
  const label = live ? t('hereLabel', { names }) : `${t('hereLabel', { names })} · ${t('reconnecting')}`;
  const people = others.filter((member) => member.kind === 'user');
  const agents = others.filter((member) => member.kind === 'session');
  const row = (member: LiveMember) => (
    <li key={member.key} data-live-member={member.key}>
      <div className="text-foreground flex min-h-9 items-center gap-2.5 px-2 py-1 text-sm">
        <LiveFace member={member} />
        <span className="min-w-0 flex-1 truncate">
          {member.name}
          {member.you ? <span className="text-muted-foreground"> · {t('you')}</span> : null}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs">{statusLabel(member.status)}</span>
      </div>
    </li>
  );
  const trigger = (
    <PopoverTrigger asChild>
      <button
        type="button"
        aria-label={label}
        data-live-avatars
        data-live-status={status}
        className={cn(
          'hover:bg-secondary flex h-7 shrink-0 items-center rounded-md px-1 transition-opacity duration-fast',
          !live && 'opacity-50',
        )}
      >
        {compact ? (
          <span className="text-foreground flex items-center gap-1 px-0.5 text-xs font-medium tabular-nums">
            <UsersIcon className="size-3.5 shrink-0" aria-hidden />
            {others.length}
          </span>
        ) : (
          // Side by side, not overlapped: each face's color ring must read whole.
          <span className="flex items-center gap-1.5 px-0.5" aria-hidden>
            {/* Each face has its own hint: the name and the status. */}
            {shown.map((member) => (
              <LiveFace
                key={member.key}
                member={member}
                hint={`${member.name} · ${statusLabel(member.status)}`}
              />
            ))}
            {more > 0 ? (
              // `min-w-6 w-auto`: the tile grows with the count, never under 24px (the access stack's tile).
              <span className="bg-muted text-muted-foreground ring-background relative flex h-6 w-auto min-w-6 items-center justify-center rounded-sm px-1.5 text-xs font-medium tabular-nums ring-2">
                +{more}
              </span>
            ) : null}
          </span>
        )}
      </button>
    </PopoverTrigger>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {compact ? (
        <Hint label={label} side="bottom" sideOffset={6} alignOffset={0}>
          {trigger}
        </Hint>
      ) : (
        trigger
      )}
      <PopoverContent align="end" sideOffset={6} className="w-72 p-0">
        <div className="text-muted-foreground flex items-center justify-between px-3.5 pt-2.5 pb-1 text-xs">
          <span>{live ? t('here') : t('reconnecting')}</span>
          <span className="tabular-nums">{others.length + (you ? 1 : 0)}</span>
        </div>
        <div className="max-h-64 overflow-y-auto overscroll-contain">
          <ul className="p-1 pt-0">
            {you ? row(you) : null}
            {people.map(row)}
          </ul>
          {agents.length ? (
            <>
              <p className="text-muted-foreground px-3.5 pt-1.5 pb-1 text-xs">{t('agents')}</p>
              <ul className="p-1 pt-0">{agents.map(row)}</ul>
            </>
          ) : null}
        </div>
        <Field orientation="horizontal" className="border-border border-t px-3.5 py-3">
          <FieldContent>
            <FieldLabel htmlFor={switchId} className="text-sm">
              {t('hideCursor')}
            </FieldLabel>
            <FieldDescription className="text-xs">{t('hideCursorHint')}</FieldDescription>
          </FieldContent>
          <Switch
            id={switchId}
            checked={cursorHidden}
            onCheckedChange={onCursorHiddenChange}
            className="shrink-0"
          />
        </Field>
      </PopoverContent>
    </Popover>
  );
}
