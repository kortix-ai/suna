'use client';

import { useTranslations } from '@/i18n/use-translations';
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
type NotificationTypeKey = 'onCompletion' | 'onError' | 'onQuestion' | 'onPermission';
type NotificationBehaviorKey = 'onlyWhenHidden' | 'playSound';

interface LabelDescription {
  label: string;
  description: string;
}

export interface SessionsTabCopy {
  notifications: string;
  notificationsDescription: string;
  unsupported: string;
  enableNotifications: string;
  permissionGranted: string;
  permissionDenied: string;
  permissionDefault: string;
  notificationTypes: string;
  behavior: string;
  sendTestNotification: string;
  notificationTypesCopy: Record<NotificationTypeKey, LabelDescription>;
  notificationBehaviorCopy: Record<NotificationBehaviorKey, LabelDescription>;
  sounds: string;
  soundsDescription: string;
  soundPacks: Record<SoundPack, LabelDescription>;
  volume: string;
  preview: string;
  soundEvents: Record<SoundEvent, LabelDescription>;
  testNotificationTitle: string;
  testNotificationBody: string;
}

export const DEFAULT_SESSIONS_TAB_COPY: SessionsTabCopy = {
  notifications: 'Browser notifications',
  notificationsDescription: 'Browser notifications for what happens in your sessions.',
  unsupported: 'Your browser does not support notifications.',
  enableNotifications: 'Enable notifications',
  permissionGranted: 'Browser permission granted',
  permissionDenied: 'Blocked by browser — update in browser site settings',
  permissionDefault: 'Will request browser permission when enabled',
  notificationTypes: 'Notification types',
  behavior: 'Behavior',
  sendTestNotification: 'Send test notification',
  notificationTypesCopy: {
    onCompletion: { label: 'Task completions', description: 'When a session finishes its task' },
    onError: { label: 'Errors', description: 'When a session encounters an error' },
    onQuestion: { label: 'Questions', description: 'When Kortix needs your input to continue' },
    onPermission: {
      label: 'Permission requests',
      description: 'When Kortix needs permission to use a tool',
    },
  },
  notificationBehaviorCopy: {
    onlyWhenHidden: {
      label: 'Only when tab is hidden',
      description: "Only notify when you're on another tab",
    },
    playSound: {
      label: 'Notification sound',
      description: 'Play a sound when a notification is sent',
    },
  },
  sounds: 'Sounds',
  soundsDescription: 'Sound pack played for session events.',
  soundPacks: {
    off: { label: 'Off', description: 'All sounds disabled' },
    opencode: { label: 'Default', description: 'Default sound pack' },
    kortix: { label: 'Seshion Pack', description: "Whistlin'" },
  },
  volume: 'Volume',
  preview: 'Preview',
  soundEvents: {
    completion: { label: 'Task Completion', description: 'When AI finishes a task' },
    error: { label: 'Error', description: 'When a session encounters an error' },
    notification: { label: 'Notification', description: 'Questions and permission requests' },
    send: { label: 'Message Sent', description: 'When you send a message' },
  },
  testNotificationTitle: 'Test Notification',
  testNotificationBody: 'Notifications are working correctly!',
};

const NOTIFICATION_TYPE_TOGGLES: {
  key: NotificationTypeKey;
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
  key: NotificationBehaviorKey;
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
  copy?: SessionsTabCopy;
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
  copy = DEFAULT_SESSIONS_TAB_COPY,
}: SessionsTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="sessions" />

      {/* Notifications first: it is the setting most people come here to
          change, and the one with a browser permission attached. */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          // "Browser notifications", not "Notifications": the pane itself is
          // called Notifications now, and a section repeating the pane's name
          // says nothing. Sounds is the other kind.
          title={copy.notifications}
          description={copy.notificationsDescription}
        />
        {!notificationsSupported ? (
          <div className="rounded-md border p-4">
            <p className="text-muted-foreground text-sm">{copy.unsupported}</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="rounded-md border">
              <NotificationToggle
                icon={BellSolid}
                label={copy.enableNotifications}
                description={
                  notificationPermission === 'granted'
                    ? copy.permissionGranted
                    : notificationPermission === 'denied'
                      ? copy.permissionDenied
                      : copy.permissionDefault
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
                    {copy.notificationTypes}
                  </label>
                  <div className="divide-y rounded-md border">
                    {NOTIFICATION_TYPE_TOGGLES.map((toggle) => (
                      <NotificationToggle
                        key={toggle.key}
                        icon={toggle.icon}
                        label={copy.notificationTypesCopy[toggle.key].label}
                        description={copy.notificationTypesCopy[toggle.key].description}
                        enabled={notificationPreferences[toggle.key] as boolean}
                        onToggle={(v) => onNotificationPreferenceChange(toggle.key, v)}
                        idPrefix="pref-notif-"
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-col space-y-3">
                  <label className="text-muted-foreground text-sm font-medium">
                    {copy.behavior}
                  </label>
                  <div className="divide-y rounded-md border">
                    {NOTIFICATION_BEHAVIOR_TOGGLES.map((toggle) => (
                      <NotificationToggle
                        key={toggle.key}
                        icon={toggle.icon}
                        label={copy.notificationBehaviorCopy[toggle.key].label}
                        description={copy.notificationBehaviorCopy[toggle.key].description}
                        enabled={notificationPreferences[toggle.key] as boolean}
                        onToggle={(v) => onNotificationPreferenceChange(toggle.key, v)}
                        idPrefix="pref-notif-"
                      />
                    ))}
                  </div>
                </div>

                <Button onClick={onSendTestNotification} variant="outline" size="sm">
                  {copy.sendTestNotification}
                </Button>
              </>
            )}
          </div>
        )}
      </section>

      <Separator />

      {/* Sounds */}
      <section className="space-y-3">
        <SettingsSubsectionHeader title={copy.sounds} description={copy.soundsDescription} />
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
              label={copy.soundPacks[pack.id].label}
              description={copy.soundPacks[pack.id].description}
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
                thumbLabel={copy.volume}
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
                        <label htmlFor={`pref-sound-event-${event.id}`}>
                          {copy.soundEvents[event.id].label}
                        </label>
                      </FieldTitle>
                      <FieldDescription>{copy.soundEvents[event.id].description}</FieldDescription>
                    </FieldContent>
                    <div className="flex shrink-0 items-center gap-2">
                      <Hint label={copy.preview}>
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
  const t = useTranslations('settings.sessions');
  const copy: SessionsTabCopy = {
    notifications: t('notifications'),
    notificationsDescription: t('notificationsDescription'),
    unsupported: t('unsupported'),
    enableNotifications: t('enableNotifications'),
    permissionGranted: t('permissionGranted'),
    permissionDenied: t('permissionDenied'),
    permissionDefault: t('permissionDefault'),
    notificationTypes: t('notificationTypes'),
    behavior: t('behavior'),
    sendTestNotification: t('sendTestNotification'),
    notificationTypesCopy: {
      onCompletion: {
        label: t('types.onCompletion.label'),
        description: t('types.onCompletion.description'),
      },
      onError: {
        label: t('types.onError.label'),
        description: t('types.onError.description'),
      },
      onQuestion: {
        label: t('types.onQuestion.label'),
        description: t('types.onQuestion.description'),
      },
      onPermission: {
        label: t('types.onPermission.label'),
        description: t('types.onPermission.description'),
      },
    },
    notificationBehaviorCopy: {
      onlyWhenHidden: {
        label: t('notificationBehavior.onlyWhenHidden.label'),
        description: t('notificationBehavior.onlyWhenHidden.description'),
      },
      playSound: {
        label: t('notificationBehavior.playSound.label'),
        description: t('notificationBehavior.playSound.description'),
      },
    },
    sounds: t('sounds'),
    soundsDescription: t('soundsDescription'),
    soundPacks: {
      off: {
        label: t('soundPacks.off.label'),
        description: t('soundPacks.off.description'),
      },
      opencode: {
        label: t('soundPacks.opencode.label'),
        description: t('soundPacks.opencode.description'),
      },
      kortix: {
        label: t('soundPacks.kortix.label'),
        description: t('soundPacks.kortix.description'),
      },
    },
    volume: t('volume'),
    preview: t('preview'),
    soundEvents: {
      completion: {
        label: t('soundEvents.completion.label'),
        description: t('soundEvents.completion.description'),
      },
      error: {
        label: t('soundEvents.error.label'),
        description: t('soundEvents.error.description'),
      },
      notification: {
        label: t('soundEvents.notification.label'),
        description: t('soundEvents.notification.description'),
      },
      send: {
        label: t('soundEvents.send.label'),
        description: t('soundEvents.send.description'),
      },
    },
    testNotificationTitle: t('testNotificationTitle'),
    testNotificationBody: t('testNotificationBody'),
  };
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
        title: copy.testNotificationTitle,
        body: copy.testNotificationBody,
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
      copy={copy}
    />
  );
}
