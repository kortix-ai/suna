'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { railGroups } from './rail';
import type { SettingsTab } from './settings-tabs';
import type { RailGroup, RailItem } from './type';

export interface SettingsRailChromeCopy {
  settings: string;
  backToApp: string;
  close: string;
  docs: string;
}

export const DEFAULT_SETTINGS_RAIL_CHROME_COPY: SettingsRailChromeCopy = {
  settings: 'Settings',
  backToApp: 'Back to app',
  close: 'Close',
  docs: 'Docs',
};

interface SettingsRailCopyValue {
  groups: readonly RailGroup[];
  chrome: SettingsRailChromeCopy;
}

const DEFAULT_VALUE: SettingsRailCopyValue = {
  groups: railGroups(),
  chrome: DEFAULT_SETTINGS_RAIL_CHROME_COPY,
};

const SettingsRailCopyContext = createContext<SettingsRailCopyValue>(DEFAULT_VALUE);

export function SettingsRailCopyProvider({
  groups,
  chrome,
  children,
}: SettingsRailCopyValue & { children: ReactNode }) {
  const value = useMemo(() => ({ groups, chrome }), [groups, chrome]);
  return (
    <SettingsRailCopyContext.Provider value={value}>
      {children}
    </SettingsRailCopyContext.Provider>
  );
}

export function useSettingsRailChromeCopy(): SettingsRailChromeCopy {
  return useContext(SettingsRailCopyContext).chrome;
}

export function useSettingsRailItem(tab: SettingsTab): RailItem | undefined {
  const { groups } = useContext(SettingsRailCopyContext);
  for (const group of groups) {
    const item = group.items.find((candidate) => candidate.tab === tab);
    if (item) return item;
  }
  return undefined;
}
