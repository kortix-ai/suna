'use client';

/**
 * The Preferences tab — language and keyboard shortcuts: how the app behaves
 * for you, on every device.
 *
 * This pane held seven sections until 2026-09-02. Jay split it three ways:
 * what the app LOOKS like went to Appearance (`appearance-tab.tsx` — theme,
 * wallpaper, conversation density), how a session gets your attention went to
 * Sessions (`sessions-tab.tsx` — sounds, notifications), and what is left here
 * is what changes the app's behaviour everywhere. Language leads: it is the
 * setting Jay named first ("in the preferences we need to show the language
 * selection for the whole app"), and the one a new person is most likely to
 * open Preferences for.
 *
 * `PreferencesTabView` is the pure, props-only half — every prop is optional
 * with a safe default, so it renders under `renderToStaticMarkup` with no
 * Zustand store or auth context (see `preferences-tab.test.tsx`).
 * `PreferencesTab` is the container: every hook only runs once this component
 * actually mounts, which `SettingsTabPane` guarantees happens only while this
 * tab is the active one.
 */

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
import { useLanguage } from '@/hooks/use-language';
import { locales, type Locale } from '@/i18n/config';
import { useUserPreferencesStore, type TabSwitchModifier } from '@/stores/user-preferences-store';
import { SETTINGS_SHORTCUT_KEY } from '../settings-shortcut';
import { SettingsTabHeader } from '../settings-tab-header';

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
    { label: 'Switch workspace', keys: 'Ctrl+O' },
    // The one shortcut that opens THIS panel, so a person reading the list is
    // holding proof it works. `SETTINGS_SHORTCUT_KEY` rather than a literal
    // comma: the handler and the row that prints it read the same constant
    // (`settings/settings-shortcut.ts`), so the advertised key cannot drift
    // from the handled one. Either modifier works — the label shows the one
    // the reader picked above.
    { label: 'Settings', keys: `${modLabel}+${SETTINGS_SHORTCUT_KEY}` },
    { label: 'Toggle left sidebar', keys: 'Ctrl+B' },
    { label: 'Toggle right sidebar', keys: 'Ctrl+Shift+B' },
    { label: 'Toggle session action panel', keys: `${modLabel}+I` },
  ];
}

export interface PreferencesTabViewProps {
  // Language
  locale?: Locale;
  availableLocales?: readonly Locale[];
  onLocaleChange?: (locale: Locale) => void;

  // Keyboard shortcuts
  keyboardModifier?: TabSwitchModifier;
  onKeyboardModifierChange?: (value: TabSwitchModifier) => void;
  modifierLabel?: string;
}

/** Presentational only — no hooks, no store read. */
export function PreferencesTabView({
  locale = 'en',
  availableLocales = locales,
  onLocaleChange = () => {},
  keyboardModifier = 'ctrl',
  onKeyboardModifierChange = () => {},
  modifierLabel = 'Ctrl',
}: PreferencesTabViewProps) {
  const shortcuts = shortcutList(modifierLabel);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="preferences" />

      {/* Language */}
      <section className="flex flex-col items-start justify-between gap-4 md:flex-row md:gap-10">
        <SettingsSubsectionHeader
          title="Language"
          description="The language Kortix displays, everywhere in the app."
        />
        <Select value={locale} onValueChange={(value) => onLocaleChange(value as Locale)}>
          <SelectTrigger id="preferences-language" aria-label="Language" className="w-48">
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

      <Separator />

      {/* Keyboard shortcuts */}
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
    </div>
  );
}

/** Container: owns every hook (the preferences store, `useLanguage`) and
 *  renders `PreferencesTabView` with real data + handlers. Only ever mounted
 *  while this tab is active. */
export function PreferencesTab() {
  const keyboardModifier = useUserPreferencesStore((s) => s.preferences.keyboard.tabSwitchModifier);
  const setKeyboardPreferences = useUserPreferencesStore((s) => s.setKeyboardPreferences);
  const modifierLabel = useUserPreferencesStore((s) => s.getModifierLabel());

  // `useLanguage` reads the signed-in user (via `useAuth`) for its persisted
  // locale, so this container only ever runs this read while mounted, i.e.
  // while this tab is active.
  const { locale, setLanguage, availableLanguages } = useLanguage();

  return (
    <PreferencesTabView
      locale={locale}
      availableLocales={availableLanguages}
      onLocaleChange={(next) => void setLanguage(next)}
      keyboardModifier={keyboardModifier}
      onKeyboardModifierChange={(modifier) =>
        setKeyboardPreferences({ tabSwitchModifier: modifier, closeTabModifier: modifier })
      }
      modifierLabel={modifierLabel}
    />
  );
}
