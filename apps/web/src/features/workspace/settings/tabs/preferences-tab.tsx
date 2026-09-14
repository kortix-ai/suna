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
 * `PreferencesTabView` is the pure, props-only half. Its localized copy is a
 * required prop, so the view cannot render user-facing fallback text from the
 * source file. It renders under `renderToStaticMarkup` with no Zustand store
 * or auth context (see `preferences-tab.test.tsx`).
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
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { useLanguage } from '@/hooks/use-language';
import { localeNames, locales, type Locale } from '@/i18n/config';
import { useUserPreferencesStore, type TabSwitchModifier } from '@/stores/user-preferences-store';
import { useTranslations } from '@/i18n/use-translations';
import { SETTINGS_SHORTCUT_KEY } from '../settings-shortcut';

export interface PreferencesCopy {
  title: string;
  description: string;
  languageTitle: string;
  languageDescription: string;
  keyboardTitle: string;
  keyboardDescription: string;
  modifierKey: string;
  shortcuts: {
    newTab: string;
    closeActiveTab: string;
    reopenClosedTab: string;
    nextTab: string;
    previousTab: string;
    nextTabAlt: string;
    previousTabAlt: string;
    switchToTabRange: string;
    switchToLastTab: string;
    newSession: string;
    commandPalette: string;
    switchWorkspace: string;
    settings: string;
    toggleLeftSidebar: string;
    toggleRightSidebar: string;
    toggleSessionActionPanel: string;
  };
}

const MODIFIER_OPTIONS: { value: TabSwitchModifier; label: string }[] = [
  { value: 'meta', label: 'Cmd' },
  { value: 'ctrl', label: 'Ctrl' },
];

function shortcutList(
  modLabel: string,
  labels: PreferencesCopy['shortcuts'],
): { label: string; keys: string }[] {
  return [
    { label: labels.newTab, keys: `${modLabel}+T` },
    { label: labels.closeActiveTab, keys: 'Ctrl+W' },
    { label: labels.reopenClosedTab, keys: `${modLabel}+Shift+T` },
    { label: labels.nextTab, keys: `${modLabel}+Shift+]` },
    { label: labels.previousTab, keys: `${modLabel}+Shift+[` },
    { label: labels.nextTabAlt, keys: `${modLabel}+Alt+→` },
    { label: labels.previousTabAlt, keys: `${modLabel}+Alt+←` },
    { label: labels.switchToTabRange, keys: `${modLabel}+1 ... ${modLabel}+8` },
    { label: labels.switchToLastTab, keys: `${modLabel}+9` },
    { label: labels.newSession, keys: 'Ctrl+J' },
    { label: labels.commandPalette, keys: 'Ctrl+K' },
    { label: labels.switchWorkspace, keys: 'Ctrl+O' },
    // The one shortcut that opens THIS panel, so a person reading the list is
    // holding proof it works. `SETTINGS_SHORTCUT_KEY` rather than a literal
    // comma: the handler and the row that prints it read the same constant
    // (`settings/settings-shortcut.ts`), so the advertised key cannot drift
    // from the handled one. Either modifier works — the label shows the one
    // the reader picked above.
    { label: labels.settings, keys: `${modLabel}+${SETTINGS_SHORTCUT_KEY}` },
    { label: labels.toggleLeftSidebar, keys: 'Ctrl+B' },
    { label: labels.toggleRightSidebar, keys: 'Ctrl+Shift+B' },
    { label: labels.toggleSessionActionPanel, keys: `${modLabel}+I` },
  ];
}

export interface PreferencesTabViewProps {
  copy: PreferencesCopy;
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
  copy,
  locale = 'en',
  availableLocales = locales,
  onLocaleChange = () => {},
  keyboardModifier = 'ctrl',
  onKeyboardModifierChange = () => {},
  modifierLabel = 'Ctrl',
}: PreferencesTabViewProps) {
  const shortcuts = shortcutList(modifierLabel, copy.shortcuts);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsSectionHeader title={copy.title} description={copy.description} className="pb-1" />

      {/* Language */}
      <section className="flex flex-col items-start justify-between gap-4 md:flex-row md:gap-10">
        <SettingsSubsectionHeader
          title={copy.languageTitle}
          description={copy.languageDescription}
        />
        <Select value={locale} onValueChange={(value) => onLocaleChange(value as Locale)}>
          <SelectTrigger id="preferences-language" aria-label={copy.languageTitle} className="w-48">
            <SelectValue>{localeNames[locale] ?? locale}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {availableLocales.map((l) => (
              <SelectItem key={l} value={l}>
                {localeNames[l]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <Separator />

      {/* Keyboard shortcuts */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={copy.keyboardTitle}
          description={copy.keyboardDescription}
        />
        <div className="space-y-2">
          <Label className="text-xs">{copy.modifierKey}</Label>
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
  const t = useTranslations('settings.preferences');
  const keyboardModifier = useUserPreferencesStore((s) => s.preferences.keyboard.tabSwitchModifier);
  const setKeyboardPreferences = useUserPreferencesStore((s) => s.setKeyboardPreferences);
  const modifierLabel = useUserPreferencesStore((s) => s.getModifierLabel());

  // `useLanguage` reads the signed-in user (via `useAuth`) for its persisted
  // locale, so this container only ever runs this read while mounted, i.e.
  // while this tab is active.
  const { locale, setLanguage, availableLanguages } = useLanguage();

  const copy: PreferencesCopy = {
    title: t('title'),
    description: t('description'),
    languageTitle: t('languageTitle'),
    languageDescription: t('languageDescription'),
    keyboardTitle: t('keyboardTitle'),
    keyboardDescription: t('keyboardDescription'),
    modifierKey: t('modifierKey'),
    shortcuts: {
      newTab: t('shortcuts.newTab'),
      closeActiveTab: t('shortcuts.closeActiveTab'),
      reopenClosedTab: t('shortcuts.reopenClosedTab'),
      nextTab: t('shortcuts.nextTab'),
      previousTab: t('shortcuts.previousTab'),
      nextTabAlt: t('shortcuts.nextTabAlt'),
      previousTabAlt: t('shortcuts.previousTabAlt'),
      switchToTabRange: t('shortcuts.switchToTabRange'),
      switchToLastTab: t('shortcuts.switchToLastTab'),
      newSession: t('shortcuts.newSession'),
      commandPalette: t('shortcuts.commandPalette'),
      switchWorkspace: t('shortcuts.switchWorkspace'),
      settings: t('shortcuts.settings'),
      toggleLeftSidebar: t('shortcuts.toggleLeftSidebar'),
      toggleRightSidebar: t('shortcuts.toggleRightSidebar'),
      toggleSessionActionPanel: t('shortcuts.toggleSessionActionPanel'),
    },
  };

  return (
    <PreferencesTabView
      copy={copy}
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
