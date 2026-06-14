'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import Hint from '@/components/ui/hint';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { previewSound } from '@/lib/sounds';
import { useSoundStore, type SoundEvent, type SoundPack } from '@/stores/sound-store';
import { Volume2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function SoundsTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const preferences = useSoundStore((s) => s.preferences);
  const setPack = useSoundStore((s) => s.setPack);
  const setVolume = useSoundStore((s) => s.setVolume);
  const setEventEnabled = useSoundStore((s) => s.setEventEnabled);

  const packs: { id: SoundPack; label: string; description: string }[] = [
    { id: 'off', label: 'Off', description: 'All sounds disabled' },
    { id: 'opencode', label: 'Default', description: 'Default sound pack' },
    { id: 'kortix', label: 'Seshion Pack', description: 'Whistlin' },
  ];

  const events: { id: SoundEvent; label: string; description: string }[] = [
    { id: 'completion', label: 'Task Completion', description: 'When AI finishes a task' },
    { id: 'error', label: 'Error', description: 'When a session encounters an error' },
    { id: 'notification', label: 'Notification', description: 'Questions and permission requests' },
    { id: 'send', label: 'Message Sent', description: 'When you send a message' },
  ];

  return (
    <div className="scrollbar-hide space-y-6 p-6">
      <div className="flex flex-col space-y-3">
        <label className="text-muted-foreground text-sm font-medium">
          {tHardcodedUi.raw('componentsSettingsUserSettingsModal.line962JsxTextSoundPack')}
        </label>
        <RadioGroup
          value={preferences.pack}
          onValueChange={(value) => setPack(value as SoundPack)}
          className="space-y-2"
        >
          {packs.map((pack) => (
            <RadioGroupItem
              size="lg"
              variant="outline"
              key={`${pack.id}-radio-group-item`}
              value={pack.id}
              id={`pack-${pack.id}`}
              label={pack.label}
              description={pack.description}
            />
          ))}
        </RadioGroup>
      </div>

      {preferences.pack !== 'off' && (
        <>
          <div className="flex flex-col space-y-3">
            <label className="text-muted-foreground text-sm font-medium">Volume</label>
            <div className="flex items-center gap-3 px-1">
              <Volume2 className="text-muted-foreground size-4 shrink-0" />
              <Slider
                min={0}
                max={100}
                value={[Math.round(preferences.volume * 100)]}
                onValueChange={(value) => setVolume(value[0] / 100)}
                // className="accent-foreground h-1.5 flex-1 cursor-pointer"
              />
              <span className="text-muted-foreground w-8 text-right text-xs tabular-nums">
                {Math.round(preferences.volume * 100)}%
              </span>
            </div>
          </div>

          <div className="flex flex-col space-y-3">
            <label className="text-muted-foreground text-sm font-medium">
              {tHardcodedUi.raw('componentsSettingsUserSettingsModal.line1012JsxTextSoundEvents')}
            </label>
            <div className="divide-y rounded-lg border">
              {events.map((event) => {
                const enabled = preferences.events[event.id] !== false;
                return (
                  <Field key={event.id} orientation="horizontal" className="group px-3.5 py-2.5">
                    <FieldContent className="gap-0">
                      <FieldTitle>{event.label}</FieldTitle>
                      <FieldDescription>{event.description}</FieldDescription>
                    </FieldContent>
                    <div className="flex shrink-0 items-center gap-2">
                      <Hint label="Preview">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                          onClick={() => previewSound(event.id)}
                        >
                          <Volume2 />
                        </Button>
                      </Hint>
                      <Switch
                        checked={enabled}
                        onCheckedChange={(v) => setEventEnabled(event.id, v)}
                      />
                    </div>
                  </Field>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
