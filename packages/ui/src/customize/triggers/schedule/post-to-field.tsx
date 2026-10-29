'use client';

import { useFeatureFlag, useProjectSpaces } from '@kortix/sdk/react';
import { capitalizeWords, isMetaAgentName, META_AGENT_DISPLAY_NAME } from '@kortix/shared';
import { HashIcon, LockSimpleIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../../i18n';
import { AgentMark } from '../../../internal/components/agent-mark';
import { Label } from '../../../primitives/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../primitives/select';
import { useUiViewerId } from '../../../providers/ui-provider';
import type { PatchDraft } from './composer-parts';
import { type ComposerDraft, postToChange } from './trigger-composer-logic';

/** Select has no empty value: this one stands for "no channel". */
const NONE = 'none';

/**
 * "Post to": the channel or DM each run starts a thread in. Shown only while
 * the project's `project_channels` flag is on. A private channel shows
 * disabled with its lock and why: the API refuses a trigger into one (a saved
 * trigger already posting there stays selectable). A channel shares later runs
 * with the project unless the person chose other sharing; a DM shares them
 * with the viewer and runs the DM's agent (`postToChange`; the API enforces
 * the DM rules).
 */
export function PostToField({
  projectId,
  draft,
  patch,
  baseAccess,
}: {
  projectId: string;
  draft: ComposerDraft;
  patch: PatchDraft;
  /** The sharing before any space was picked: the saved trigger's, or the form's default. */
  baseAccess: ComposerDraft['sessionAccess'];
}) {
  const t = useTranslations('triggerComposer');
  const viewerId = useUiViewerId();
  const channelsOn = useFeatureFlag(projectId, 'project_channels').enabled === true;
  const spaces = useProjectSpaces(projectId, { enabled: channelsOn });
  if (!channelsOn) return null;
  const list = spaces.data ?? [];
  // A saved trigger's archived channel is not in the list: keep it selectable.
  // Another member's DM never reaches the form (the API lists its trigger with
  // no space), so it shows as no channel.
  const unknown = draft.spaceId && !list.some((space) => space.space_id === draft.spaceId);

  const choose = (value: string) => {
    if (value === draft.spaceId) return;
    const space = list.find((candidate) => candidate.space_id === value);
    const current = list.find((candidate) => candidate.space_id === draft.spaceId) ?? null;
    patch(
      postToChange(
        draft,
        space ? { spaceId: space.space_id, kind: space.kind, dmAgentName: space.dm_agent_name } : null,
        { base: baseAccess, current, viewerId },
      ),
    );
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="trigger-post-to" className="text-xs">
        {t('postTo')}
      </Label>
      <Select value={draft.spaceId ?? NONE} onValueChange={choose}>
        <SelectTrigger id="trigger-post-to" className="w-full cursor-pointer text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE} className="cursor-pointer">
            {t('postToNone')}
          </SelectItem>
          {unknown ? (
            <SelectItem value={draft.spaceId!} className="cursor-pointer">
              {t('postToUnavailable')}
            </SelectItem>
          ) : null}
          {list.map((space) => {
            const locked = space.visibility === 'private';
            return (
              <SelectItem
                key={space.space_id}
                value={space.space_id}
                disabled={locked && space.space_id !== draft.spaceId}
                className="cursor-pointer"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {space.kind !== 'channel' ? (
                    <AgentMark slug={space.dm_agent_name ?? 'kortix'} size={14} tile={18} />
                  ) : locked ? (
                    <LockSimpleIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                  ) : (
                    <HashIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                  {space.kind === 'channel' ? space.slug : agentLabel(space.dm_agent_name ?? '')}
                  {locked ? <span className="text-muted-foreground truncate text-xs">{t('postToPrivate')}</span> : null}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs text-pretty">
        {/* The default channel can be renamed: name it as it is now. */}
        {t('postToHint', { channel: list.find((space) => space.is_default)?.slug ?? 'general' })}
      </p>
    </div>
  );
}

function agentLabel(name: string): string {
  return isMetaAgentName(name) ? META_AGENT_DISPLAY_NAME : capitalizeWords(name);
}
