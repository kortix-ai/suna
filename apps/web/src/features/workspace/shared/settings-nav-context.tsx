'use client';

/**
 * Panel-agnostic navigation surface for the section/tab views shared between
 * the legacy Customize overlay (`customize/customize-panel.tsx`, backed by
 * `stores/customize-store.ts`) and the new Settings overlay
 * (`settings/settings-panel.tsx`, backed by `stores/settings-panel-store.ts`).
 *
 * Five views under `features/workspace/customize/sections/**` used to import
 * `useCustomizeStore` directly, but for exactly ONE thing: panel navigation
 * (which tab is active, whether the panel is open, and how to jump
 * elsewhere). That direct import is what stopped them from ever mounting
 * under the new panel — they would read the legacy store, which the new
 * panel never touches, and silently do nothing.
 *
 * This context breaks that coupling. Each panel provides an adapter over its
 * own store (`customize-panel.tsx`'s `buildCustomizeSettingsNav`,
 * `settings-panel.tsx`'s `buildSettingsPanelSettingsNav`); the five views
 * read only `useSettingsNav()`, never a store directly.
 *
 * `activeTab` (and `navigate`'s `tab` argument) is typed `string`, NOT
 * `CustomizeSection` or `SettingsTab`. The two panels speak different tab
 * vocabularies (`llm-management` vs `models`, `git` vs `repositories`, ...)
 * until a later task unifies them (see `settings-tabs.ts`'s header). Forcing
 * one union onto this shared surface now would silently widen or narrow
 * whichever panel doesn't own it — precisely the aliasing mistake that once
 * took `tsc` from 17 errors to 61 on this branch. Keep it `string`; each
 * adapter casts to its own concrete union internally, where the cast is
 * cheap to audit.
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface SettingsNav {
  /** The tab/section currently shown by the hosting panel. */
  activeTab: string;
  /**
   * Whether the hosting panel is open. Both panels only mount section
   * content while `open` is true (see each panel's `SectionContent` /
   * tab-pane gate), so in practice this is always `true` for the lifetime of
   * a mounted consumer — see `gateway-view.tsx`'s use of it for why it still
   * reads this instead of assuming so.
   */
  isOpen: boolean;
  /** Jump the hosting panel to a different tab. */
  navigate: (tab: string, opts?: { membersTab?: string }) => void;
  /** Which Members sub-tab to land on (e.g. straight to Invite). */
  membersTab?: string;
  /**
   * Which LLM Providers sub-tab to land on. Legacy-panel only — the new
   * panel has no equivalent field (its `models` tab's internal sub-nav is
   * local component state, see `settings-panel-store.ts`'s header), so its
   * adapter always reports `undefined` here.
   */
  llmProvidersTab?: string;
}

const SettingsNavContext = createContext<SettingsNav | null>(null);

export function SettingsNavProvider({
  value,
  children,
}: {
  value: SettingsNav;
  children: ReactNode;
}) {
  return <SettingsNavContext.Provider value={value}>{children}</SettingsNavContext.Provider>;
}

/**
 * Read the hosting panel's navigation surface.
 *
 * Throws outside a provider — this NEVER returns a silent no-op default. A
 * view that quietly stops navigating because nobody wrapped it in a provider
 * is exactly the failure this context exists to prevent, and a no-op default
 * would make that failure invisible in review.
 */
export function useSettingsNav(): SettingsNav {
  const ctx = useContext(SettingsNavContext);
  if (!ctx) {
    throw new Error(
      'useSettingsNav() was called outside a SettingsNavProvider. Render this view under ' +
        'CustomizPanel (customize/customize-panel.tsx) or SettingsPanel ' +
        '(settings/settings-panel.tsx), which provide it — or wrap it in a ' +
        '<SettingsNavProvider value={...}> in a test.',
    );
  }
  return ctx;
}
