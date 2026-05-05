import * as React from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { haptics } from '@/lib/haptics';
import {
  Check,
  CircleOff,
  Music,
  Play,
  Vibrate,
  Volume2,
  Zap,
  AlertCircle,
  Bell,
  Send,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  useSoundStore,
  type SoundEvent,
  type SoundPack,
} from '@/stores/sound-store';
import { previewSound } from '@/lib/sounds';

const PACKS: { id: SoundPack; label: string; description: string; icon: typeof Volume2 }[] = [
  { id: 'off', label: 'Off', description: 'All sounds disabled', icon: CircleOff },
  { id: 'opencode', label: 'Default', description: 'Default sound pack', icon: Volume2 },
  { id: 'kortix', label: 'Seshion Pack', description: 'Whistlin\'', icon: Music },
];

const EVENTS: { id: SoundEvent; label: string; description: string; icon: typeof Volume2 }[] = [
  { id: 'completion', label: 'Task Completion', description: 'When AI finishes a task', icon: Zap },
  { id: 'error', label: 'Error', description: 'When a session encounters an error', icon: AlertCircle },
  { id: 'notification', label: 'Notification', description: 'Questions and permission requests', icon: Bell },
  { id: 'send', label: 'Message Sent', description: 'When you send a message', icon: Send },
];

export default function SoundsScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const preferences = useSoundStore((s) => s.preferences);
  const setPack = useSoundStore((s) => s.setPack);
  const setEventEnabled = useSoundStore((s) => s.setEventEnabled);
  const setHapticsEnabled = useSoundStore((s) => s.setHapticsEnabled);

  const trackOff = isDark ? '#3A3A3C' : '#E5E7EB';
  const isOff = preferences.pack === 'off';

  const handlePackSelect = React.useCallback((pack: SoundPack) => {
    haptics.selection();
    setPack(pack);
  }, [setPack]);

  const handleEventToggle = React.useCallback((event: SoundEvent, enabled: boolean) => {
    haptics.selection();
    setEventEnabled(event, enabled);
  }, [setEventEnabled]);

  const handlePreview = React.useCallback((event: SoundEvent) => {
    haptics.tap();
    previewSound(event);
  }, []);

  const handleHapticsToggle = React.useCallback((enabled: boolean) => {
    // Persist FIRST so the wrapper's `isEnabled()` check sees the new value
    // when we fire the preview tap — otherwise it reads the old `false` and
    // we'd toggle on without any haptic confirmation.
    setHapticsEnabled(enabled);
    if (enabled) {
      haptics.tap();
    }
  }, [setHapticsEnabled]);

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <View className="px-5 pt-1" style={{ gap: 18 }}>
        {/* Sound Pack */}
        <View className="px-1">
          <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
            Sound Pack
          </Text>
          <View>
            {PACKS.map((pack, idx) => {
              const selected = preferences.pack === pack.id;
              const isLast = idx === PACKS.length - 1;
              return (
                <Pressable
                  key={pack.id}
                  onPress={() => handlePackSelect(pack.id)}
                  className="active:opacity-85"
                >
                  <View className="py-3.5">
                    <View className="flex-row items-center">
                      <Icon as={pack.icon} size={18} className="text-foreground/80" strokeWidth={2.2} />
                      <View className="ml-4 flex-1">
                        <Text className="font-roobert-medium text-[15px] text-foreground">
                          {pack.label}
                        </Text>
                        <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">
                          {pack.description}
                        </Text>
                      </View>
                      {selected && (
                        <Icon as={Check} size={16} className="text-primary" strokeWidth={2.7} />
                      )}
                    </View>
                  </View>
                  {!isLast && <View className="h-px bg-border/35" />}
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Sound Events */}
        {!isOff && (
          <View className="px-1">
            <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
              Sound Events
            </Text>
            <View>
              {EVENTS.map((event, idx) => {
                const enabled = preferences.events[event.id] !== false;
                const isLast = idx === EVENTS.length - 1;
                return (
                  <View key={event.id}>
                    <View className="py-3.5">
                      <View className="flex-row items-center">
                        <Icon as={event.icon} size={18} className="text-foreground/80" strokeWidth={2.2} />
                        <View className="ml-4 flex-1">
                          <Text className="font-roobert-medium text-[15px] text-foreground">
                            {event.label}
                          </Text>
                          <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">
                            {event.description}
                          </Text>
                        </View>
                        <Pressable
                          onPress={() => handlePreview(event.id)}
                          className="mr-3 h-7 items-center justify-center rounded-lg bg-muted/60 px-2.5 active:opacity-70"
                          hitSlop={4}
                        >
                          <View className="flex-row items-center" style={{ gap: 4 }}>
                            <Icon as={Play} size={10} className="text-muted-foreground" strokeWidth={2.5} />
                            <Text className="font-roobert-medium text-[11px] text-muted-foreground">
                              Preview
                            </Text>
                          </View>
                        </Pressable>
                        <Switch
                          value={enabled}
                          onValueChange={(v) => handleEventToggle(event.id, v)}
                          trackColor={{ false: trackOff, true: '#34C759' }}
                          thumbColor="#FFFFFF"
                          ios_backgroundColor={trackOff}
                        />
                      </View>
                    </View>
                    {!isLast && <View className="h-px bg-border/35" />}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* Feedback */}
        <View className="px-1">
          <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
            Feedback
          </Text>
          <View className="py-3.5">
            <View className="flex-row items-center">
              <Icon as={Vibrate} size={18} className="text-foreground/80" strokeWidth={2.2} />
              <View className="ml-4 flex-1">
                <Text className="font-roobert-medium text-[15px] text-foreground">
                  Haptic Feedback
                </Text>
                <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">
                  Vibration feedback on taps and actions
                </Text>
              </View>
              <Switch
                value={preferences.hapticsEnabled}
                onValueChange={handleHapticsToggle}
                trackColor={{ false: trackOff, true: '#34C759' }}
                thumbColor="#FFFFFF"
                ios_backgroundColor={trackOff}
              />
            </View>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}
