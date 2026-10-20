'use client';

import { useTranslations } from '@/i18n/use-translations';

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

import { Button } from '@kortix/ui/button';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@kortix/ui/field';
import Hint from '@kortix/ui/hint';
import { RadioGroup, RadioGroupItem } from '@kortix/ui/radio-group';
import { Separator } from '@kortix/ui/separator';
import { SettingsSubsectionHeader } from '@kortix/ui/settings-subsection-header';
import { Skeleton } from '@kortix/ui/skeleton';
import { Slider } from '@kortix/ui/slider';
import { Switch } from '@kortix/ui/switch';
import { NotificationToggle } from '@/features/accounts/settings/notifications-tab';
import { ErrorState } from '@kortix/ui/error-state';
import { useNotificationCenter } from '@kortix/ui/internal/hooks/use-notification-center';
import { webPushSupported } from '@kortix/ui/internal/notifications/web-push';
import { useAuth } from '@/features/providers/auth-provider';
import { isDesktop } from '@kortix/ui/internal/lib/desktop';
import { previewSound } from '@kortix/ui/internal/lib/sounds';
import { isNotificationSupported, sendWebNotification } from '@kortix/ui/internal/lib/web-notifications';
import { useSoundStore, type SoundEvent, type SoundPack } from '@kortix/ui/internal/stores/sound-store';
import {
  useWebNotificationStore,
  type WebNotificationPermission,
  type WebNotificationPreferences,
} from '@kortix/ui/internal/stores/web-notification-store';
import {
  DEFAULT_NOTIFICATION_PREFERENCES as DEFAULT_KIND_PREFERENCES,
  INBOX_NOTIFICATION_KINDS,
  type InboxNotificationKind,
  type NotificationPreferences,
} from '@kortix/sdk';
import { useNotificationPreferences } from '@kortix/sdk/react';
import { SettingsTabHeader } from '@kortix/ui/customize/settings/settings-tab-header';

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
/** Where "Enable notifications" can reach: Web Push, the desktop app, or open tabs only. */
type NotificationReach = 'push' | 'desktop' | 'browser';
type NotificationChannel = 'push' | 'email';
/** Permission requests are never emailed: they go stale before a digest is due. */
const NEVER_EMAILED: readonly InboxNotificationKind[] = ['permission'];
/** One width for a channel's label and its switches, so they line up. */
const CHANNEL_COLUMN = 'flex w-16 shrink-0 justify-center text-center';

interface LabelDescription {
  label: string;
  description: string;
}

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
  onEnableCompletionSound?: () => void;

  // Browser notifications (this browser)
  notificationsSupported?: boolean;
  notificationReach?: NotificationReach;
  notificationPermission?: WebNotificationPermission;
  notificationPreferences?: WebNotificationPreferences;
  onToggleNotificationsEnabled?: () => void;
  onNotificationPreferenceChange?: <K extends NotificationPrefKey>(
    key: K,
    value: WebNotificationPreferences[K],
  ) => void;
  onSendTestNotification?: () => void;

  /** The `notification_center` flag. Off: the four per-browser kind switches; on: the server record. */
  notificationCenter?: boolean;
  // Notification types (the person's server record)
  notificationKinds?: NotificationPreferences['kinds'];
  /** False when the deployment sends no email: the Email column is hidden. */
  emailAvailable?: boolean;
  notificationKindsState?: 'loading' | 'error' | 'ready';
  onNotificationKindChange?: (
    kind: InboxNotificationKind,
    channel: NotificationChannel,
    value: boolean,
  ) => void;
  onRetryNotificationKinds?: () => void;
  copy?: ReturnType<typeof useSessionCopy>;
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
  onEnableCompletionSound = () => {},
  notificationsSupported = true,
  notificationReach = 'push',
  notificationPermission = 'default',
  notificationPreferences = DEFAULT_NOTIFICATION_PREFERENCES,
  onToggleNotificationsEnabled = () => {},
  onNotificationPreferenceChange = () => {},
  onSendTestNotification = () => {},
  notificationCenter = false,
  notificationKinds = DEFAULT_KIND_PREFERENCES,
  emailAvailable = true,
  notificationKindsState = 'ready',
  onNotificationKindChange = () => {},
  onRetryNotificationKinds = () => {},
  copy: copyOverride,
}: SessionsTabViewProps) {
  const tRecovery = useTranslations('settings.sessions.recovery');
  const translatedCopy = useSessionCopy();
  const copy = copyOverride ?? translatedCopy;
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
                  notificationPermission === 'denied'
                    ? copy.permissionDenied
                    : notificationCenter
                      ? copy.enableDescription[notificationReach]
                      : notificationPermission === 'granted'
                        ? copy.permissionGranted
                        : copy.permissionDefault
                }
                enabled={notificationPreferences.enabled}
                onToggle={onToggleNotificationsEnabled}
                idPrefix="pref-notif-"
              />
            </div>

            {notificationPermission === 'denied' && (
              <div className="space-y-3">
                <details className="text-muted-foreground text-xs">
                  <summary>{tRecovery('instructions')}</summary>
                  <ul className="mt-2 space-y-2">
                    {(['chrome', 'edge', 'firefox', 'safari'] as const).map((browser) => (
                      <li key={browser}>{tRecovery(browser)}</li>
                    ))}
                  </ul>
                  <p className="mt-2">{tRecovery('afterChange')}</p>
                </details>
                <p className="text-muted-foreground text-xs">{tRecovery('fallback')}</p>
                <Button variant="outline" size="sm" onClick={onEnableCompletionSound}>
                  {tRecovery('enableSound')}
                </Button>
              </div>
            )}

            {notificationPreferences.enabled && (
              <>
                {!notificationCenter && (
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
                )}

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

      {notificationCenter && (
        <>
          <Separator />

          {/* The person's record, not this browser's: visible whether or not this
              browser shows notifications, because it also decides what the phone
              and the email digest get. */}
          <section className="space-y-3">
            <SettingsSubsectionHeader
              title={copy.notificationTypes}
              description={copy.notificationTypesDescription}
            />
            {notificationKindsState === 'error' ? (
              <ErrorState
                size="sm"
                title={copy.preferencesLoadError}
                action={
                  <Button variant="outline" size="sm" onClick={onRetryNotificationKinds}>
                    {copy.retry}
                  </Button>
                }
              />
            ) : (
              // A list, not a `Table`: a table earns the pane the wide tier
              // (tab-content-width.test.ts). Each switch carries the kind and the
              // channel in its name, so the column labels are visual only.
              <div className="divide-y rounded-md border">
                <div
                  aria-hidden
                  className="text-muted-foreground flex items-center gap-4 px-4 py-2 text-xs"
                >
                  <span className="flex-1" />
                  <span className={CHANNEL_COLUMN}>{copy.push}</span>
                  {emailAvailable && <span className={CHANNEL_COLUMN}>{copy.email}</span>}
                </div>
                {INBOX_NOTIFICATION_KINDS.map((kind) => {
                  const label = copy.kinds[kind].label;
                  const channelCell = (channel: NotificationChannel) => (
                    <span className={CHANNEL_COLUMN}>
                      {notificationKindsState === 'loading' ? (
                        <Skeleton className="mx-auto h-5 w-9 rounded-full py-0" />
                      ) : (
                        <Switch
                          aria-label={copy.channelSwitch(
                            label,
                            channel === 'push' ? copy.push : copy.email,
                          )}
                          checked={notificationKinds[kind][channel]}
                          onCheckedChange={(value) =>
                            onNotificationKindChange(kind, channel, value)
                          }
                        />
                      )}
                    </span>
                  );
                  return (
                    <div key={kind} className="flex items-center gap-4 px-4 py-3">
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-muted-foreground text-xs text-pretty">
                          {copy.kinds[kind].description}
                        </p>
                      </div>
                      {channelCell('push')}
                      {emailAvailable &&
                        (NEVER_EMAILED.includes(kind) ? (
                          <span aria-hidden className={CHANNEL_COLUMN} />
                        ) : (
                          channelCell('email')
                        ))}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

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

/** Where "Enable notifications" reaches in this renderer. */
function notificationReach(): NotificationReach {
  if (isDesktop()) return 'desktop';
  return webPushSupported() ? 'push' : 'browser';
}

/** Container: owns every store hook and renders `SessionsTabView`. Only ever
 *  mounted while this tab is active. `projectId` is absent on the standalone
 *  `/settings` route: the flag then reads any cached project. */
export function SessionsTab({ projectId }: { projectId?: string }) {
  const t = useTranslations('settings.sessions');
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

  const { user } = useAuth();
  const notificationCenter = useNotificationCenter(projectId);
  const kindPreferences = useNotificationPreferences({
    userId: user?.id,
    enabled: notificationCenter,
  });

  const handleSendTestNotification = () => {
    sendWebNotification(
      {
        type: 'completion',
        title: t('testNotificationTitle'),
        body: t('testNotificationBody'),
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
      onEnableCompletionSound={() => {
        if (soundPreferences.pack === 'off') setSoundPack('opencode');
        if (soundPreferences.volume <= 0) setSoundVolume(0.5);
        setSoundEventEnabled('completion', true);
        setNotificationPreference('playSound', true);
        previewSound('completion');
      }}
      notificationsSupported={isNotificationSupported()}
      notificationReach={notificationReach()}
      notificationPermission={notificationPermission}
      notificationPreferences={notificationPreferences}
      onToggleNotificationsEnabled={() => void toggleNotificationsEnabled()}
      onNotificationPreferenceChange={setNotificationPreference}
      onSendTestNotification={handleSendTestNotification}
      notificationCenter={notificationCenter}
      notificationKinds={kindPreferences.data?.kinds}
      emailAvailable={kindPreferences.data?.email_available ?? true}
      notificationKindsState={
        kindPreferences.data ? 'ready' : kindPreferences.isError ? 'error' : 'loading'
      }
      onNotificationKindChange={(kind, channel, value) => {
        // The API's error toast reports a failure; the switch flips back.
        kindPreferences.update({ kinds: { [kind]: { [channel]: value } } }).catch(() => {});
      }}
      onRetryNotificationKinds={() => void kindPreferences.refetch()}
    />
  );
}

function useSessionCopy() {
  const t = useTranslations('settings.sessions');
  const browserCopy = useTranslations('hardcodedUi.i18nComplete');
  const tNotifications = useTranslations('notifications');
  const kindCopy = (kind: InboxNotificationKind): LabelDescription => ({
    label: tNotifications(`kind.${kind}`),
    description: tNotifications(`kindDescription.${kind}`),
  });
  const copy = {
    notifications: browserCopy('text7761b572aba8'),
    notificationsDescription: t('notificationsDescription'),
    unsupported: t('unsupported'),
    enableNotifications: t('enableNotifications'),
    enableDescription: {
      push: t('enableDescriptionPush'),
      desktop: t('enableDescriptionDesktop'),
      browser: t('enableDescriptionBrowser'),
    },
    permissionGranted: t('permissionGranted'),
    permissionDenied: t('permissionDenied'),
    permissionDefault: t('permissionDefault'),
    notificationTypes: t('notificationTypes'),
    notificationTypesDescription: t('notificationTypesDescription'),
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
    kinds: Object.fromEntries(
      INBOX_NOTIFICATION_KINDS.map((kind: InboxNotificationKind) => [kind, kindCopy(kind)]),
    ) as Record<InboxNotificationKind, LabelDescription>,
    push: t('push'),
    email: t('email'),
    // `kind` and `channel` arrive as the already-localized labels the switch
    // row renders next to, not the raw enum values.
    channelSwitch: (kind: string, channel: string) => t('channelSwitch', { kind, channel }),
    preferencesLoadError: t('preferencesLoadError'),
    retry: t('retry'),
    behavior: t('behavior'),
    sendTestNotification: t('sendTestNotification'),
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
  return copy;
}
