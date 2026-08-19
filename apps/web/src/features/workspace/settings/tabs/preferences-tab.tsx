'use client';

/**
 * The Preferences tab — seven sections, appearance leading because the product
 * owner specified a full light/dark system as the centrepiece: theme,
 * wallpaper, conversation density, sounds, notifications, keyboard shortcuts,
 * language.
 *
 * Theme values come from `THEME_OPTIONS` in `features/layout/user-menu.tsx`
 * (imported, not re-declared) so this panel's theme control and the user
 * menu's theme submenu can never drift apart — see that file's comment next
 * to the export. `user-menu.tsx` itself is untouched by this task.
 *
 * Ported from five `features/accounts/settings/*.tsx` files. Task 10 deleted
 * their legacy modal consumer; `appearance-tab.tsx` and `notifications-tab.tsx`
 * survive as the home for `WallpaperCard` / `NotificationToggle` (their
 * full-page `AppearanceTab` / `NotificationsTab` components, which had no
 * remaining consumer once the modal was deleted, were removed — see that
 * task's report):
 * - `appearance-tab.tsx` — theme + wallpaper. `WallpaperCard` is exported
 *   from there and reused directly here (only the `export` keyword changed
 *   on that file); this tab does NOT carry the Session-panel or Layout
 *   sections from that file — those belong to the session-panel experience,
 *   not user preferences, and have no home in this task's six-section list.
 * - `notifications-tab.tsx` — `NotificationToggle` is exported from there and
 *   reused directly here (same treatment as `WallpaperCard` above; only the
 *   `export` keyword and an `idPrefix` prop were added, both no-ops for the
 *   original component itself — see that file's comment on the prop).
 * - `sounds-tab.tsx`, `keyboard-shortcuts-tab.tsx`, `language-switcher.tsx`
 *   — no exported pieces worth reusing (each is a single self-contained
 *   component with no sub-parts split out), so their JSX bodies are
 *   re-implemented here against `SettingsSubsectionHeader` instead of the old
 *   bare `<label>` headers. This task's report documents this as the
 *   precise duplication: the markup shape of these three sections, not any
 *   shared logic (every store call is a live import, not a copy).
 *
 * None of the five source files call `useTranslations` results into this
 * tab — like `ProfileTab` (Task 7), copy here is plain English, matching the
 * newer settings-panel surfaces rather than the legacy modal's translation
 * scaffolding.
 *
 * `PreferencesTabView` is the pure, props-only half — every prop is optional
 * with a safe default, so it renders under `renderToStaticMarkup` with no
 * `next-themes` provider, Zustand store, or auth context (see
 * `preferences-tab.test.tsx`). `PreferencesTab` is the container: every hook
 * only runs once this component actually mounts, which `SettingsTabPane`
 * guarantees happens only while this tab is the active one.
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
import { useTheme } from 'next-themes';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import Hint from '@/components/ui/hint';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { WallpaperCard } from '@/features/accounts/settings/appearance-tab';
import { NotificationToggle } from '@/features/accounts/settings/notifications-tab';
import { THEME_OPTIONS } from '@/features/layout/user-menu';
import { useLanguage } from '@/hooks/use-language';
import { locales, type Locale } from '@/i18n/config';
import { previewSound } from '@/lib/sounds';
import { cn } from '@/lib/utils';
import { DEFAULT_WALLPAPER_ID, WALLPAPERS, type Wallpaper } from '@/lib/wallpapers';
import { isNotificationSupported, sendWebNotification } from '@/lib/web-notifications';
import { useSoundStore, type SoundEvent, type SoundPack } from '@/stores/sound-store';
import {
  useUserPreferencesStore,
  type ConversationDensity,
  type TabSwitchModifier,
} from '@/stores/user-preferences-store';
import {
  useWebNotificationStore,
  type WebNotificationPermission,
  type WebNotificationPreferences,
} from '@/stores/web-notification-store';
import { SettingsTabHeader } from '../settings-tab-header';

const DENSITY_OPTIONS: { id: ConversationDensity; label: string; description: string }[] = [
  {
    id: 'normal',
    label: 'Normal',
    description: 'Steps and thinking stream live while Kortix works.',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'One status line until you expand it.',
  },
];

/**
 * Skeleton mock of the live activity burst at each density, drawn with the
 * same bar-and-dot vocabulary as `Skeleton` surfaces. The two previews ARE the
 * explanation — 'normal' shows the summary line over an open chain (rows +
 * thinking paragraph), 'minimal' shows the one status line and the quiet that
 * is the point of the mode. Decorative only, so `aria-hidden`; the card's
 * label + description carry the accessible name.
 */
function DensityPreview({ density }: { density: ConversationDensity }) {
  if (density === 'minimal') {
    return (
      <div aria-hidden>
        <div className="bg-muted-foreground/35 h-1.5 w-16 rounded-full" />
      </div>
    );
  }
  return (
    <div aria-hidden className="space-y-2">
      {/* Summary line */}
      <div className="bg-muted-foreground/35 h-1.5 w-16 rounded-full" />
      {/* Thinking row + its streaming paragraph */}
      <div className="flex items-center gap-2">
        <div className="bg-muted-foreground/30 size-2.5 shrink-0 rounded-full" />
        <div className="bg-muted-foreground/20 h-1.5 w-14 rounded-full" />
      </div>
      <div className="space-y-1.5 pl-[18px]">
        <div className="bg-muted-foreground/15 h-1.5 w-full rounded-full" />
        <div className="bg-muted-foreground/15 h-1.5 w-3/4 rounded-full" />
      </div>
      {/* A tool row */}
      <div className="flex items-center gap-2">
        <div className="bg-muted-foreground/30 size-2.5 shrink-0 rounded-full" />
        <div className="bg-muted-foreground/20 h-1.5 w-20 rounded-full" />
      </div>
    </div>
  );
}

/**
 * One selectable density card — the same shape as `WallpaperCard` (preview
 * panel + caption below), because this section sits two sections under the
 * wallpaper grid and the two pickers should read as one vocabulary. Radio
 * semantics rather than `aria-pressed` buttons: the two options are exclusive.
 */
function DensityCard({
  option,
  isActive,
  onSelect,
}: {
  option: (typeof DENSITY_OPTIONS)[number];
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isActive}
      data-density={option.id}
      onClick={onSelect}
      className="group relative cursor-pointer rounded-md text-left"
    >
      <div
        className={cn(
          'bg-popover relative h-24 w-full overflow-hidden rounded-md border p-3 transition-colors duration-200',
          isActive ? 'border-primary/40' : 'border-border group-hover:border-border/80',
        )}
      >
        <DensityPreview density={option.id} />
        {isActive && (
          <div className="absolute top-2.5 right-2.5">
            <CheckCircleSolid weight="fill" className="size-4" />
          </div>
        )}
      </div>
      <div className="px-1.5 py-1">
        <span className="text-foreground text-xs font-medium">{option.label}</span>
      </div>
    </button>
  );
}

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

const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  it: 'Italiano',
  zh: '中文',
  ja: '日本語',
  pt: 'Português',
  fr: 'Français',
  es: 'Español',
};

const MODIFIER_OPTIONS: { value: TabSwitchModifier; label: string }[] = [
  { value: 'meta', label: 'Cmd' },
  { value: 'ctrl', label: 'Ctrl' },
];

function shortcutList(modLabel: string): { label: string; keys: string }[] {
  return [
    { label: 'New tab', keys: `${modLabel}+T` },
    { label: 'Close active tab', keys: 'Ctrl+W' },
    { label: 'Reopen closed tab', keys: `${modLabel}+Shift+T` },
    { label: 'Next tab', keys: `${modLabel}+Shift+]` },
    { label: 'Previous tab', keys: `${modLabel}+Shift+[` },
    { label: 'Next tab (alt)', keys: `${modLabel}+Alt+→` },
    { label: 'Previous tab (alt)', keys: `${modLabel}+Alt+←` },
    { label: 'Switch to tab 1-8', keys: `${modLabel}+1 ... ${modLabel}+8` },
    { label: 'Switch to last tab', keys: `${modLabel}+9` },
    { label: 'New session', keys: 'Ctrl+J' },
    { label: 'Command palette', keys: 'Ctrl+K' },
    { label: 'Toggle left sidebar', keys: 'Ctrl+B' },
    { label: 'Toggle right sidebar', keys: 'Ctrl+Shift+B' },
    { label: 'Toggle session action panel', keys: `${modLabel}+I` },
  ];
}

export interface PreferencesTabViewProps {
  // Theme
  theme?: string;
  onThemeChange?: (value: string) => void;

  // Wallpaper
  wallpaperId?: string;
  isLightTheme?: boolean;
  onWallpaperSelect?: (id: Wallpaper['id']) => void;

  // Conversation density
  conversationDensity?: ConversationDensity;
  onConversationDensityChange?: (density: ConversationDensity) => void;

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

  // Keyboard shortcuts
  keyboardModifier?: TabSwitchModifier;
  onKeyboardModifierChange?: (value: TabSwitchModifier) => void;
  modifierLabel?: string;

  // Language
  locale?: Locale;
  availableLocales?: readonly Locale[];
  onLocaleChange?: (locale: Locale) => void;
}

const DEFAULT_NOTIFICATION_PREFERENCES: WebNotificationPreferences = {
  enabled: false,
  onCompletion: true,
  onError: true,
  onQuestion: true,
  onPermission: true,
  onlyWhenHidden: true,
  playSound: false,
};

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `PreferencesTab` so this renders under
 *  `renderToStaticMarkup` without `next-themes`, a Zustand store, or an auth
 *  session — see `ProfileTabView` for the same split. Every prop is optional
 *  with a safe default so the bare `<PreferencesTabView />` the test file
 *  renders shows every section fully formed. */
export function PreferencesTabView({
  theme = 'system',
  onThemeChange = () => {},
  wallpaperId = DEFAULT_WALLPAPER_ID,
  isLightTheme = false,
  onWallpaperSelect = () => {},
  conversationDensity = 'normal',
  onConversationDensityChange = () => {},
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
  keyboardModifier = 'ctrl',
  onKeyboardModifierChange = () => {},
  modifierLabel = 'Ctrl',
  locale = 'en',
  availableLocales = locales,
  onLocaleChange = () => {},
}: PreferencesTabViewProps) {
  const shortcuts = shortcutList(modifierLabel);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="preferences" />

      {/* 1. Theme */}
      <section className="flex flex-col items-start justify-between gap-4 md:flex-row md:gap-10">
        <SettingsSubsectionHeader
          title="Theme"
          description="Choose how Kortix looks on this device."
        />
        <div className="bg-foreground/10 flex w-fit items-center gap-1 rounded-md p-0.5">
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              aria-pressed={theme === value}
              className="text-foreground inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-3 transition-[color,background-color,scale] duration-150 ease-out active:scale-[0.96] [&>svg]:size-4"
              style={{ backgroundColor: theme === value ? 'var(--background)' : 'transparent' }}
              onClick={() => onThemeChange(value)}
            >
              <Icon />
              <span className="text-sm font-medium">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <Separator />

      {/* 3. Conversation density */}
      <section className="flex flex-col items-start justify-between gap-4 space-y-3 md:flex-row md:gap-10">
        <SettingsSubsectionHeader
          title="Conversation density"
          description="How much detail the agent shows in the conversation while it works."
        />
        <div
          role="radiogroup"
          aria-label="Conversation density"
          className="grid w-full max-w-xs grid-cols-2 gap-2"
        >
          {DENSITY_OPTIONS.map((option) => (
            <DensityCard
              key={option.id}
              option={option}
              isActive={conversationDensity === option.id}
              onSelect={() => onConversationDensityChange(option.id)}
            />
          ))}
        </div>
      </section>

      <Separator />

      {/* 2. Wallpaper */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Wallpaper"
          description="The background behind your workspace."
        />
        <div className="grid w-full grid-cols-3 gap-2">
          {WALLPAPERS.map((wp) => (
            <WallpaperCard
              key={wp.id}
              wallpaper={wp}
              thumbSrc={wp.thumbs ? (isLightTheme ? wp.thumbs.light : wp.thumbs.dark) : undefined}
              isActive={wallpaperId === wp.id}
              onSelect={() => onWallpaperSelect(wp.id)}
            />
          ))}
        </div>
      </section>

      <Separator />

      {/* 4. Sounds */}
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
                          className="text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100"
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

      <Separator />

      {/* 5. Notifications */}
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

      {/* 6. Keyboard shortcuts */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Keyboard shortcuts"
          description="The modifier key used for tab switching, and every shortcut in the app."
        />
        <div className="space-y-2">
          <Label className="text-xs">Modifier key</Label>
          <RadioGroup
            value={keyboardModifier}
            onValueChange={(value) => onKeyboardModifierChange(value as TabSwitchModifier)}
            className="grid w-fit grid-cols-2 items-center gap-2"
          >
            {MODIFIER_OPTIONS.map((mod) => (
              <RadioGroupItem
                key={mod.value}
                value={mod.value}
                id={`pref-mod-${mod.value}`}
                label={mod.label}
              />
            ))}
          </RadioGroup>
        </div>

        <div className="divide-y rounded-md border">
          {shortcuts.map((s) => (
            <div key={s.label} className="flex items-center justify-between px-3 py-2.5">
              <span className="text-foreground text-sm">{s.label}</span>
              <kbd className="bg-muted text-muted-foreground inline-flex h-6 items-center rounded border px-2 font-mono text-xs whitespace-nowrap">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </section>

      <Separator />

      {/* 7. Language */}
      <section className="space-y-3">
        <SettingsSubsectionHeader title="Language" description="The language Kortix displays." />
        <Select value={locale} onValueChange={(value) => onLocaleChange(value as Locale)}>
          <SelectTrigger id="preferences-language" className="!h-11 w-full max-w-xs">
            <SelectValue>{LANGUAGE_NAMES[locale] ?? locale}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {availableLocales.map((l) => (
              <SelectItem key={l} value={l}>
                {LANGUAGE_NAMES[l]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>
    </div>
  );
}

/** Container: owns every hook (next-themes, Zustand stores, auth) and renders
 *  `PreferencesTabView` with real data + handlers. Only ever mounted while
 *  this tab is active (`SettingsTabPane` in `settings-panel.tsx` returns
 *  `null` otherwise), so nothing here fetches or reads storage on panel
 *  open unless the user actually lands on this tab. */
export function PreferencesTab() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const wallpaperId = useUserPreferencesStore(
    (s) => s.preferences.wallpaperId ?? DEFAULT_WALLPAPER_ID,
  );
  const setWallpaperId = useUserPreferencesStore((s) => s.setWallpaperId);
  const keyboardModifier = useUserPreferencesStore((s) => s.preferences.keyboard.tabSwitchModifier);
  const setKeyboardPreferences = useUserPreferencesStore((s) => s.setKeyboardPreferences);
  const modifierLabel = useUserPreferencesStore((s) => s.getModifierLabel());
  // `?? 'normal'` — legacy persisted preferences predate this key (same rule
  // as every `panelMode` read site).
  const conversationDensity = useUserPreferencesStore(
    (s) => s.preferences.conversationDensity ?? 'normal',
  );
  const setConversationDensity = useUserPreferencesStore((s) => s.setConversationDensity);

  // Users may have a wallpaper persisted that no longer exists — reset it.
  // Mirrors the identical effect in `appearance-tab.tsx`; both surfaces read
  // and write the same store key, so this is a genuine, small duplication
  // (~4 lines) rather than a divergent implementation — see this file's
  // header comment.
  useEffect(() => {
    if (!WALLPAPERS.some((w) => w.id === wallpaperId)) {
      setWallpaperId(DEFAULT_WALLPAPER_ID);
    }
  }, [wallpaperId, setWallpaperId]);

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

  // `useLanguage` reads the signed-in user (via `useAuth`) for its persisted
  // locale, so this container — like `ProfileTab` — only ever runs this read
  // while mounted, i.e. while this tab is active.
  const { locale, setLanguage, availableLanguages } = useLanguage();

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
    <PreferencesTabView
      theme={theme ?? 'system'}
      onThemeChange={setTheme}
      wallpaperId={wallpaperId}
      isLightTheme={resolvedTheme === 'light'}
      onWallpaperSelect={setWallpaperId}
      conversationDensity={conversationDensity}
      onConversationDensityChange={setConversationDensity}
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
      keyboardModifier={keyboardModifier}
      onKeyboardModifierChange={(modifier) =>
        setKeyboardPreferences({ tabSwitchModifier: modifier, closeTabModifier: modifier })
      }
      modifierLabel={modifierLabel}
      locale={locale}
      availableLocales={availableLanguages}
      onLocaleChange={(next) => void setLanguage(next)}
    />
  );
}
