'use client';

/**
 * The Sessions tab — what a running session is allowed to do to get your
 * attention: sounds and browser notifications.
 *
 * Split out of Preferences on 2026-09-02 (Jay: "use a section for the
 * sessions"). Both settings answer one question — "how does a session tell me
 * it needs me?" — and they had been two of seven headings on a pane that also
 * held theme, wallpaper, shortcuts and language.
 *
 * `NotificationToggle` is reused from
 * `features/accounts/settings/notifications-tab.tsx`. Every store call is a
 * live import (`useSoundStore`, `useWebNotificationStore`), not a copy.
 *
 * `SessionsTabView` is the pure, props-only half — it renders under
 * `renderToStaticMarkup` with no store (see `sessions-tab.test.tsx`).
 * `SessionsTab` is the container; it only mounts while this tab is active.
 */

import {
  BellIcon as BellSolid,
  CheckCircleIcon as CheckCircleSolid,
  WarningIcon as DangerTriangleSolid,
  EyeSlashIcon as EyeOffSolid,
  QuestionIcon as QuestionCircleSolid,
  ShieldCheckIcon as ShieldCheckSolid,
  SpeakerHighIcon as Volume2,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import Hint from '@/components/ui/hint';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { NotificationToggle } from '@/features/accounts/settings/notifications-tab';
import { previewSound } from '@/lib/sounds';
import { isNotificationSupported, sendWebNotification } from '@/lib/web-notifications';
import { useSoundStore, type SoundEvent, type SoundPack } from '@/stores/sound-store';
import {
  useWebNotificationStore,
  type WebNotificationPermission,
  type WebNotificationPreferences,
} from '@/stores/web-notification-store';
import { SettingsTabHeader } from '../settings-tab-header';

const SOUND_PACKS: { id: SoundPack; label: string; description: string }[] = [
  { id: 'off', label: 'Off', description: 'All sounds disabled' },
  { id: 'opencode', label: 'Default', description: 'Default sound pack' },
  { id: 'kortix', label: 'Seshion Pack', description: 'Whistlin' },
];

const SOUND_EVENTS: { id: SoundEvent; label: string; description: string }[] = [
  { id: 'completion', label: 'Task Completion', description: 'When AI finishes a task' },
  { id: 'error', label: 'Error', description: 'When a session encounters an error' },
  { id: 'notification', label: 'Notification', description: 'Questions and permission requests' },
  { id: 'send', label: 'Message Sent', description: 'When you send a message' },
];

type NotificationPrefKey = Exclude<keyof WebNotificationPreferences, 'enabled'>;

const NOTIFICATION_TYPE_TOGGLES: {
  key: NotificationPrefKey;
  icon: PhosphorIcon;
  label: string;
  description: string;
}[] = [
  {
    key: 'onCompletion',
    icon: CheckCircleSolid,
    label: 'Task completions',
    description: 'When a session finishes its task',
  },
  {
    key: 'onError',
    icon: DangerTriangleSolid,
    label: 'Errors',
    description: 'When a session encounters an error',
  },
  {
    key: 'onQuestion',
    icon: QuestionCircleSolid,
    label: 'Questions',
    description: 'When Kortix needs your input to continue',
  },
  {
    key: 'onPermission',
    icon: ShieldCheckSolid,
    label: 'Permission requests',
    description: 'When Kortix needs permission to use a tool',
  },
];

const NOTIFICATION_BEHAVIOR_TOGGLES: {
  key: NotificationPrefKey;
  icon: PhosphorIcon;
  label: string;
  description: string;
}[] = [
  {
    key: 'onlyWhenHidden',
    icon: EyeOffSolid,
    label: 'Only when tab is hidden',
    description: "Only notify when you're on another tab",
  },
  {
    key: 'playSound',
    icon: Volume2,
    label: 'Notification sound',
    description: 'Play a sound when a notification is sent',
  },
];

const DEFAULT_NOTIFICATION_PREFERENCES: WebNotificationPreferences = {
  enabled: false,
  onCompletion: true,
  onError: true,
  onQuestion: true,
  onPermission: true,
  onlyWhenHidden: true,
  playSound: false,
};

export interface SessionsTabViewProps {
  // Sounds
  soundPack?: SoundPack;
  onSoundPackChange?: (pack: SoundPack) => void;
  soundVolume?: number;
  onSoundVolumeChange?: (volume: number) => void;
  soundEvents?: Partial<Record<SoundEvent, boolean>>;
  onSoundEventToggle?: (event: SoundEvent, enabled: boolean) => void;
  onSoundPreview?: (event: SoundEvent) => void;

  // Notifications
  notificationsSupported?: boolean;
  notificationPermission?: WebNotificationPermission;
  notificationPreferences?: WebNotificationPreferences;
  onToggleNotificationsEnabled?: () => void;
  onNotificationPreferenceChange?: <K extends NotificationPrefKey>(
    key: K,
    value: WebNotificationPreferences[K],
  ) => void;
  onSendTestNotification?: () => void;
}

/** Presentational only — no hooks, no store read. Every prop is optional with
 *  a safe default so the bare `<SessionsTabView />` renders every section. */
export function SessionsTabView({
  soundPack = 'off',
  onSoundPackChange = () => {},
  soundVolume = 0.5,
  onSoundVolumeChange = () => {},
  soundEvents = {},
  onSoundEventToggle = () => {},
  onSoundPreview = () => {},
  notificationsSupported = true,
  notificationPermission = 'default',
  notificationPreferences = DEFAULT_NOTIFICATION_PREFERENCES,
  onToggleNotificationsEnabled = () => {},
  onNotificationPreferenceChange = () => {},
  onSendTestNotification = () => {},
}: SessionsTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="sessions" />

      {/* Notifications first: it is the setting most people come here to
          change, and the one with a browser permission attached. */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Notifications"
          description="Browser notifications for what happens in your sessions."
        />
        {!notificationsSupported ? (
          <div className="rounded-md border p-4">
            <p className="text-muted-foreground text-sm">
              Your browser does not support notifications.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="rounded-md border">
              <NotificationToggle
                icon={BellSolid}
                label="Enable notifications"
                description={
                  notificationPermission === 'granted'
                    ? 'Browser permission granted'
                    : notificationPermission === 'denied'
                      ? 'Blocked by browser — update in browser site settings'
                      : 'Will request browser permission when enabled'
                }
                enabled={notificationPreferences.enabled}
                onToggle={onToggleNotificationsEnabled}
                idPrefix="pref-notif-"
              />
            </div>

            {notificationPreferences.enabled && (
              <>
                <div className="flex flex-col space-y-3">
                  <label className="text-muted-foreground text-sm font-medium">
                    Notification types
                  </label>
                  <div className="divide-y rounded-md border">
                    {NOTIFICATION_TYPE_TOGGLES.map((toggle) => (
                      <NotificationToggle
                        key={toggle.key}
                        icon={toggle.icon}
                        label={toggle.label}
                        description={toggle.description}
                        enabled={notificationPreferences[toggle.key] as boolean}
                        onToggle={(v) => onNotificationPreferenceChange(toggle.key, v)}
                        idPrefix="pref-notif-"
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-col space-y-3">
                  <label className="text-muted-foreground text-sm font-medium">Behavior</label>
                  <div className="divide-y rounded-md border">
                    {NOTIFICATION_BEHAVIOR_TOGGLES.map((toggle) => (
                      <NotificationToggle
                        key={toggle.key}
                        icon={toggle.icon}
                        label={toggle.label}
                        description={toggle.description}
                        enabled={notificationPreferences[toggle.key] as boolean}
                        onToggle={(v) => onNotificationPreferenceChange(toggle.key, v)}
                        idPrefix="pref-notif-"
                      />
                    ))}
                  </div>
                </div>

                <Button onClick={onSendTestNotification} variant="outline" size="sm">
                  Send test notification
                </Button>
              </>
            )}
          </div>
        )}
      </section>

      <Separator />

      {/* Sounds */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Sounds"
          description="Sound pack played for session events."
        />
        <RadioGroup
          value={soundPack}
          onValueChange={(value) => onSoundPackChange(value as SoundPack)}
          className="space-y-2"
        >
          {SOUND_PACKS.map((pack) => (
            <RadioGroupItem
              size="lg"
              variant="outline"
              key={pack.id}
              value={pack.id}
              id={`pref-sound-pack-${pack.id}`}
              label={pack.label}
              description={pack.description}
            />
          ))}
        </RadioGroup>

        {soundPack !== 'off' && (
          <>
            <div className="flex items-center gap-3 px-1">
              <Volume2 className="text-muted-foreground size-4 shrink-0" />
              <Slider
                min={0}
                max={100}
                value={[Math.round(soundVolume * 100)]}
                thumbLabel="Volume"
                formatValue={(value) => `${value}%`}
                onValueChange={(value) => onSoundVolumeChange(value[0] / 100)}
              />
              <span className="text-muted-foreground w-8 text-right text-xs tabular-nums">
                {Math.round(soundVolume * 100)}%
              </span>
            </div>

            <div className="divide-y rounded-md border">
              {SOUND_EVENTS.map((event) => {
                const enabled = soundEvents[event.id] !== false;
                return (
                  <Field key={event.id} orientation="horizontal" className="group px-3.5 py-2.5">
                    <FieldContent className="gap-0">
                      <FieldTitle>
                        <label htmlFor={`pref-sound-event-${event.id}`}>{event.label}</label>
                      </FieldTitle>
                      <FieldDescription>{event.description}</FieldDescription>
                    </FieldContent>
                    <div className="flex shrink-0 items-center gap-2">
                      <Hint label="Preview">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground duration-moderate opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => onSoundPreview(event.id)}
                        >
                          <Volume2 />
                        </Button>
                      </Hint>
                      <Switch
                        id={`pref-sound-event-${event.id}`}
                        checked={enabled}
                        onCheckedChange={(v) => onSoundEventToggle(event.id, v)}
                      />
                    </div>
                  </Field>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** Container: owns every store hook and renders `SessionsTabView`. Only ever
 *  mounted while this tab is active. */
export function SessionsTab() {
  const soundPreferences = useSoundStore((s) => s.preferences);
  const setSoundPack = useSoundStore((s) => s.setPack);
  const setSoundVolume = useSoundStore((s) => s.setVolume);
  const setSoundEventEnabled = useSoundStore((s) => s.setEventEnabled);

  const notificationPermission = useWebNotificationStore((s) => s.permission);
  const notificationPreferences = useWebNotificationStore((s) => s.preferences);
  const toggleNotificationsEnabled = useWebNotificationStore((s) => s.toggleEnabled);
  const setNotificationPreference = useWebNotificationStore((s) => s.setPreference);
  const syncNotificationPermission = useWebNotificationStore((s) => s.syncPermission);
  useEffect(() => {
    syncNotificationPermission();
  }, [syncNotificationPermission]);

  const handleSendTestNotification = () => {
    sendWebNotification(
      {
        type: 'completion',
        title: 'Test Notification',
        body: 'Notifications are working correctly!',
        tag: 'test',
      },
      true,
    );
  };

  return (
    <SessionsTabView
      soundPack={soundPreferences.pack}
      onSoundPackChange={setSoundPack}
      soundVolume={soundPreferences.volume}
      onSoundVolumeChange={setSoundVolume}
      soundEvents={soundPreferences.events}
      onSoundEventToggle={setSoundEventEnabled}
      onSoundPreview={previewSound}
      notificationsSupported={isNotificationSupported()}
      notificationPermission={notificationPermission}
      notificationPreferences={notificationPreferences}
      onToggleNotificationsEnabled={() => void toggleNotificationsEnabled()}
      onNotificationPreferenceChange={setNotificationPreference}
      onSendTestNotification={handleSendTestNotification}
    />
  );
}
