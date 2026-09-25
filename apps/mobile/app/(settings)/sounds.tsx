import * as React from 'react';
import { View } from 'react-native';
import {
  WarningCircleIcon as AlertCircle,
  BellIcon as Bell,
  ProhibitIcon as CircleOff,
  MusicNotesIcon as Music,
  PlayIcon as Play,
  PaperPlaneTiltIcon as Send,
  VibrateIcon as Vibrate,
  SpeakerHighIcon as Volume2,
  LightningIcon as Zap,
} from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { haptics } from '@/lib/haptics';
import { previewSound } from '@/lib/sounds';
import { useSoundStore, type SoundEvent, type SoundPack } from '@/stores/sound-store';

const PACKS: { id: SoundPack; label: string; icon: typeof Volume2 }[] = [
  { id: 'off', label: 'Off', icon: CircleOff },
  { id: 'opencode', label: 'Default', icon: Volume2 },
  { id: 'kortix', label: 'Seshion pack', icon: Music },
];

const EVENTS: { id: SoundEvent; label: string; icon: typeof Volume2 }[] = [
  { id: 'completion', label: 'Task completion', icon: Zap },
  { id: 'error', label: 'Error', icon: AlertCircle },
  { id: 'notification', label: 'Notification', icon: Bell },
  { id: 'send', label: 'Message sent', icon: Send },
];

export default function SoundsScreen() {
  const preferences = useSoundStore((s) => s.preferences);
  const setPack = useSoundStore((s) => s.setPack);
  const setEventEnabled = useSoundStore((s) => s.setEventEnabled);
  const setHapticsEnabled = useSoundStore((s) => s.setHapticsEnabled);

  const isOff = preferences.pack === 'off';

  const handlePackSelect = React.useCallback(
    (pack: SoundPack) => {
      haptics.selection();
      setPack(pack);
    },
    [setPack]
  );

  const handleEventToggle = React.useCallback(
    (event: SoundEvent, enabled: boolean) => {
      haptics.selection();
      setEventEnabled(event, enabled);
    },
    [setEventEnabled]
  );

  const handlePreview = React.useCallback((event: SoundEvent) => {
    haptics.tap();
    previewSound(event);
  }, []);

  const handleHapticsToggle = React.useCallback(
    (enabled: boolean) => {
      // Persist FIRST so the wrapper's `isEnabled()` check sees the new value
      // when we fire the preview tap — otherwise it reads the old `false` and
      // we'd toggle on without any haptic confirmation.
      setHapticsEnabled(enabled);
      if (enabled) {
        haptics.tap();
      }
    },
    [setHapticsEnabled]
  );

  return (
    <SettingsPage>
      <SettingsGroup title="Sound pack">
        {PACKS.map((pack) => (
          <SettingsRow
            key={pack.id}
            icon={pack.icon}
            label={pack.label}
            onPress={() => handlePackSelect(pack.id)}
            checked={preferences.pack === pack.id}
            right={null}
          />
        ))}
      </SettingsGroup>

      {!isOff && (
        <SettingsGroup title="Sound events">
          {EVENTS.map((event) => (
            <SettingsRow
              key={event.id}
              icon={event.icon}
              label={event.label}
              right={
                <View className="flex-row items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="rounded-full"
                    accessibilityLabel={`Preview ${event.label} sound`}
                    onPress={() => handlePreview(event.id)}>
                    <Icon as={Play} size={16} className="text-muted-foreground" />
                  </Button>
                  <Switch
                    checked={preferences.events[event.id] !== false}
                    onCheckedChange={(v) => handleEventToggle(event.id, v)}
                  />
                </View>
              }
            />
          ))}
        </SettingsGroup>
      )}

      <SettingsGroup title="Feedback">
        <SettingsRow
          icon={Vibrate}
          label="Haptic feedback"
          right={
            <Switch checked={preferences.hapticsEnabled} onCheckedChange={handleHapticsToggle} />
          }
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
