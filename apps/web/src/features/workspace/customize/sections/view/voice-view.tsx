'use client';

/**
 * The Voice pane — what the agent is called when it joins a call.
 *
 * **Layout: the settings pane shape.** Pane heading from the rail entry
 * (`SettingsTabHeader`), then a `SettingsRowGroup` — label left, control
 * right, the shape `profile-tab.tsx` and `general-tab.tsx` use. It used to be
 * `CustomizeSectionWrapper` with a hardcoded title and a three-sentence
 * description, over a `max-w-md` stack of `<Label>` → input+button → help
 * paragraph: the pre-Linear vertical form, in a panel where every other pane
 * reads as two columns.
 *
 * The pane description lived in two places — here and `rail.ts`'s
 * `VOICE_ITEM`, which never rendered because this view supplied its own. The
 * rail entry is the single source now, and its wording is the merge of the two
 * (see the comment there).
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { errorToast, successToast } from '@/components/ui/toast';
import { SettingsTabHeader } from '@/features/workspace/settings/settings-tab-header';
import { useSetVoiceBotName } from '@/hooks/channels/use-voice-settings';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

const DEFAULT_BOT_NAME = 'Kortix';

export function VoiceView({ projectId }: { projectId: string }) {
  const setBotName = useSetVoiceBotName();
  // Read-only unless the role can write customize settings; fails closed while
  // the probe resolves.
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;
  const [name, setName] = useState('');

  const dirty = name.trim().length > 0;

  async function onSave() {
    if (!dirty) return;
    try {
      const saved = await setBotName.mutateAsync({ projectId, name: name.trim() });
      successToast(`Bot name set to ${saved.bot_name}`);
      setName('');
    } catch (err) {
      errorToast(err instanceof Error ? err.message : 'Failed to save name');
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="voice" />
      <SettingsRowGroup>
        <SettingsRow
          label="Display name in the call"
          description={
            canWrite
              ? `What participants see in the attendee list. Defaults to ${DEFAULT_BOT_NAME}.`
              : 'You do not have permission to change this.'
          }
        >
          <Input
            // The row label is a heading, not a `<label htmlFor>` — the control
            // carries its own accessible name. Same as `general-tab.tsx`.
            aria-label="Display name in the call"
            value={name}
            placeholder={DEFAULT_BOT_NAME}
            disabled={!canWrite || setBotName.isPending}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSave();
            }}
            // Not `variant="popover"`: the group around it is itself
            // `bg-popover`, so a popover-tinted input would vanish into it.
            className="h-8 w-56"
          />
          {/* Appears only once there is something to save, like the Name row on
              Profile — a Save that is disabled more often than not reads as a
              broken control rather than an unmet condition. */}
          {canWrite && dirty ? (
            <Button size="sm" onClick={() => void onSave()} disabled={setBotName.isPending}>
              {setBotName.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
              Save
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsRowGroup>
    </div>
  );
}
