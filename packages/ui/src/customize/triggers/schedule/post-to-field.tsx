'use client';

import { useFeatureFlag, useProjectSpaces } from '@kortix/sdk/react';
import { HashIcon, RobotIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../../i18n';
import { Label } from '../../../primitives/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../primitives/select';
import { useUiViewerId } from '../../../providers/ui-provider';
import { agentLabel } from '../../../workspace/spaces/space-timeline';
import type { PatchDraft } from './composer-parts';
import type { ComposerDraft } from './trigger-composer-logic';

/** Select has no empty value: this one stands for "no channel". */
const NONE = 'none';

/** The sharing a space implies: a channel thread is project-visible; a DM thread is the viewer's only. */
export function spaceTriggerAccess(kind: 'channel' | 'dm', viewerId: string | undefined): ComposerDraft['sessionAccess'] {
  return kind === 'dm' && viewerId
    ? { mode: 'members', memberIds: [viewerId], groupIds: [] }
    : { mode: 'project', memberIds: [], groupIds: [] };
}

/**
 * "Post to": the channel or DM each run starts a thread in. Shown only while
 * the project's `project_channels` flag is on. Picking a channel shares the
 * runs with the project, like every channel thread; picking the DM shares them
 * with the viewer only (the API enforces both).
 */
export function PostToField({ projectId, draft, patch }: { projectId: string; draft: ComposerDraft; patch: PatchDraft }) {
  const t = useTranslations('triggerComposer');
  const viewerId = useUiViewerId();
  const channelsOn = useFeatureFlag(projectId, 'project_channels').enabled === true;
  const spaces = useProjectSpaces(projectId, { enabled: channelsOn });
  if (!channelsOn) return null;
  const list = spaces.data ?? [];
  // A saved trigger's archived channel, or another member's DM, is not in the list: keep it selectable.
  const unknown = draft.spaceId && !list.some((space) => space.space_id === draft.spaceId);

  const choose = (value: string) => {
    if (value === draft.spaceId) return;
    const space = list.find((candidate) => candidate.space_id === value);
    if (!space) return patch({ spaceId: null });
    patch({ spaceId: space.space_id, sessionAccess: spaceTriggerAccess(space.kind, viewerId) });
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
          {list.map((space) => (
            <SelectItem key={space.space_id} value={space.space_id} className="cursor-pointer">
              <span className="flex items-center gap-1.5">
                {space.kind === 'channel' ? (
                  <HashIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                ) : (
                  <RobotIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                )}
                {space.kind === 'channel' ? space.slug : agentLabel(space.dm_agent_name ?? '')}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs text-pretty">{t('postToHint')}</p>
    </div>
  );
}
