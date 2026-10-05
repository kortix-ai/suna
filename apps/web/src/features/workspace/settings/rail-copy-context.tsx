'use client';

import { createContext, useContext, type ReactNode } from 'react';

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
  return (
    <SettingsRailCopyContext.Provider value={{ groups, chrome }}>
      {children}
    </SettingsRailCopyContext.Provider>
  );
}

export function useSettingsRailChromeCopy(): SettingsRailChromeCopy {
  return useContext(SettingsRailCopyContext).chrome;
}

export function useSettingsRailItem(tab: SettingsTab): RailItem | undefined {
  for (const group of useContext(SettingsRailCopyContext).groups) {
    const item = group.items.find((candidate) => candidate.tab === tab);
    if (item) return item;
  }
  return undefined;
}
