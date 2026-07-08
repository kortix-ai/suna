'use client';

import { Play } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import {
  fetchMeetVoicePreview,
  useMeetVoices,
  useSetMeetBotName,
  useSetMeetVoice,
} from '@/hooks/channels/use-meet-voices';

export function MeetView({ projectId }: { projectId: string }) {
  const voicesQuery = useMeetVoices(projectId);
  const setVoice = useSetMeetVoice();
  const setBotName = useSetMeetBotName();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);

  const data = voicesQuery.data;
  const voices = data?.voices ?? [];
  const selected = data?.selected ?? '';
  const selectedVoice = voices.find((v) => v.id === selected);
  const botName = draftName ?? data?.bot_name ?? '';
  const defaultBotName = data?.default_bot_name ?? 'Kortix Notetaker';
  const nameDirty = botName.trim().length > 0 && botName.trim() !== (data?.bot_name ?? '');

  async function onSaveName() {
    if (!nameDirty) return;
    try {
      const saved = await setBotName.mutateAsync({ projectId, name: botName.trim() });
      successToast(`Bot name set to ${saved.bot_name}`);
      setDraftName(null);
    } catch (err) {
      errorToast(err instanceof Error ? err.message : 'Failed to save name');
    }
  }

  async function onSelect(voiceId: string) {
    try {
      await setVoice.mutateAsync({ projectId, voice: voiceId });
      const name = voices.find((v) => v.id === voiceId)?.name ?? voiceId;
      successToast(`Meeting voice set to ${name}`);
    } catch (err) {
      errorToast(err instanceof Error ? err.message : 'Failed to save voice');
    }
  }

  async function onPreview(voiceId: string) {
    setPreviewing(voiceId);
    try {
      const b64 = await fetchMeetVoicePreview(projectId, voiceId);
      if (!b64) {
        errorToast('Could not generate a preview');
        setPreviewing(null);
        return;
      }
      const audio = new Audio(`data:audio/mpeg;base64,${b64}`);
      audio.onended = () => setPreviewing(null);
      audio.onerror = () => setPreviewing(null);
      await audio.play().catch(() => setPreviewing(null));
    } catch {
      errorToast('Could not play the preview');
      setPreviewing(null);
    }
  }

  return (
    <CustomizeSectionWrapper
      title="Meetings"
      description="The notetaker bot joins your calls — Google Meet, Zoom, or Microsoft Teams — transcribes with speaker labels, and answers out loud when addressed. Set its name and the voice it speaks in."
    >
      <div className="space-y-6">
        {data && !data.speak_enabled ? (
          <InfoBanner tone="warning" title="Voice replies are not configured yet">
            An operator needs to set an ElevenLabs key for the bot to speak. You can still pick a
            default voice now.
          </InfoBanner>
        ) : null}

        <section className="space-y-4">
          <Label>Bot name</Label>
          <p className="text-muted-foreground -mt-2 text-xs">
            The display name the notetaker joins under. People wake it in the call by saying its
            first name.
          </p>
          <div className="bg-popover rounded-md border px-4 py-5">
            {voicesQuery.isLoading ? (
              <Skeleton className="h-10 w-full rounded-lg" />
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  size="lg"
                  value={botName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSaveName();
                  }}
                  placeholder={defaultBotName}
                  maxLength={80}
                  className="flex-1"
                />
                <Button
                  size="lg"
                  className="shrink-0"
                  disabled={setBotName.isPending || !nameDirty}
                  onClick={onSaveName}
                >
                  Save
                </Button>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <Label>Default voice</Label>
          <p className="text-muted-foreground -mt-2 text-xs">
            Used for the bot's spoken replies in calls. Preview a voice before you set it.
          </p>
          <div className="bg-popover rounded-md border px-4 py-5">
            {voicesQuery.isLoading ? (
              <Skeleton className="h-11 w-full rounded-lg" />
            ) : voices.length === 0 ? (
              <p className="text-muted-foreground text-sm">No voices available.</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Select value={selected} onValueChange={onSelect} disabled={setVoice.isPending}>
                    <SelectTrigger size="lg" className="flex-1">
                      <SelectValue placeholder="Select a voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {voices.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          <span className="font-medium">{v.name}</span>
                          <span className="text-muted-foreground ml-2">{v.desc}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="lg"
                    className="shrink-0 gap-1.5"
                    disabled={!selected || previewing !== null}
                    onClick={() => selected && onPreview(selected)}
                  >
                    {previewing === selected ? (
                      <Loading className="size-4 shrink-0" />
                    ) : (
                      <Play className="size-4 shrink-0" />
                    )}
                    Preview
                  </Button>
                </div>
                {selectedVoice ? (
                  <p className="text-muted-foreground text-xs">
                    Current: {selectedVoice.name} — {selectedVoice.desc}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </section>
      </div>
    </CustomizeSectionWrapper>
  );
}
