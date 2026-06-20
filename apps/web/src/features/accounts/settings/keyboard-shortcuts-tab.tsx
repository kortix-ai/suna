'use client';

import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { useTranslations } from 'next-intl';

export function KeyboardShortcutsTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { preferences, setKeyboardPreferences, getModifierLabel } = useUserPreferencesStore();
  const modifier = preferences.keyboard.tabSwitchModifier;
  const modLabel = getModifierLabel();

  const shortcuts = [
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
  ];

  return (
    <div className="scrollbar-hide max-w-full min-w-0 space-y-5 overflow-x-hidden p-4 pb-12 sm:space-y-6 sm:p-6 sm:pb-6">
      <div className="space-y-3">
        <div className="space-y-0">
          <Label className="text-sm font-medium">
            {tHardcodedUi.raw('componentsSettingsUserSettingsModal.line884JsxTextModifierKey')}
          </Label>
          <p className="text-muted-foreground text-xs">
            {tHardcodedUi.raw(
              'componentsSettingsUserSettingsModal.line886JsxTextChooseWhichModifierKeyIsUsedForTab',
            )}
          </p>
        </div>
        <RadioGroup
          value={modifier}
          onValueChange={(val) =>
            setKeyboardPreferences({
              tabSwitchModifier: val as 'meta' | 'ctrl',
              closeTabModifier: val as 'meta' | 'ctrl',
            })
          }
          className="grid  grid-cols-2 items-center gap-2 w-fit"
        >
          <RadioGroupItem value="meta" id="mod-meta" label="Cmd (⌘)" />
          <RadioGroupItem value="ctrl" id="mod-ctrl" label="Ctrl (⌃)" />
        </RadioGroup>
      </div>

      <div className="flex flex-col space-y-3">
        <label className="text-sm font-medium text-muted-foreground">
          {tHardcodedUi.raw('componentsSettingsUserSettingsModal.line915JsxTextAllShortcuts')}
        </label>
        <div className="divide-y rounded-lg border">
          {shortcuts.map((s) => (
            <div key={s.label} className="flex items-center justify-between px-3 py-2.5">
              <span className="text-foreground text-sm">{s.label}</span>
              <kbd className="bg-muted text-muted-foreground inline-flex h-6 items-center rounded border px-2 font-mono text-xs whitespace-nowrap">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
