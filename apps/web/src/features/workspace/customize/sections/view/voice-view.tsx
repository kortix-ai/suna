'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorToast, successToast } from '@/components/ui/toast';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { useSetVoiceBotName } from '@/hooks/channels/use-voice-settings';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';

const DEFAULT_BOT_NAME = 'Kortix';

export function VoiceView({ workspaceId }: { workspaceId: string }) {
  const setBotName = useSetVoiceBotName();
  // Read-only unless the role can write customize settings; fails closed while
  // the probe resolves.
  const canWrite = useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE).allowed === true;
  const [name, setName] = useState('');

  const dirty = name.trim().length > 0;

  async function onSave() {
    if (!dirty) return;
    try {
      const saved = await setBotName.mutateAsync({ workspaceId, name: name.trim() });
      successToast(`Bot name set to ${saved.bot_name}`);
      setName('');
    } catch (err) {
      errorToast(err instanceof Error ? err.message : 'Failed to save name');
    }
  }

  return (
    <CustomizeSectionWrapper
      title="Voice"
      description="Send the agent into a call to talk with you. It listens continuously, answers out loud, and keeps working in the background while the conversation carries on."
    >
      <div className="flex max-w-md flex-col gap-2">
        <Label htmlFor="voice-bot-name">Display name in the call</Label>
        <div className="flex gap-2">
          <Input
            id="voice-bot-name"
            value={name}
            placeholder={DEFAULT_BOT_NAME}
            disabled={!canWrite || setBotName.isPending}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSave();
            }}
          />
          <Button onClick={() => void onSave()} disabled={!canWrite || !dirty || setBotName.isPending}>
            Save
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          What participants see in the attendee list. Defaults to {DEFAULT_BOT_NAME}.
        </p>
      </div>
    </CustomizeSectionWrapper>
  );
}
