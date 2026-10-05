/**
 * The Customize screen: Agents · Skills · Secrets · Triggers · Connectors
 * (SPEC §5.8), mirroring the web's five Customize pages.
 *
 * Two components live here:
 *
 * - `CustomizeShell` — the tab strip and the keys that move between tabs.
 *   Pure: everything it draws arrives as a prop. That is what lets the tab
 *   test drive real key presses against fixture bodies.
 * - `CustomizeScreen` — mounts the shell with the five real tabs. Only the
 *   ACTIVE tab is mounted, so a tab's queries do not run until it is on
 *   screen: five tabs mounted at once would fire five project reads, three of
 *   which (secrets, connectors, triggers) are manager-tier and 403 for an
 *   ordinary member.
 *
 * Esc lives in the shell alone, gated on `inputActive`. Every mounted
 * component receives every key in OpenTUI (there is no bubbling), so a tab
 * with an input open reports `inputActive` and the shell stops answering keys
 * until the tab closes it. Without that gate, typing `1` into a secret name
 * would also switch tabs.
 */

import { useKeyboard } from '@opentui/react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { theme } from '../../theme.ts';
import { layoutRow } from '../../ui/index.ts';
import { AgentsTab } from './agents-tab.tsx';
import { ConnectorsTab } from './connectors-tab.tsx';
import {
  CUSTOMIZE_TABS,
  type CustomizeTabId,
  matchesCustomizeBinding,
  tabIndexForDigit,
} from './keys.ts';
import { SecretsTab } from './secrets-tab.tsx';
import { SkillsTab } from './skills-tab.tsx';
import { TriggersTab } from './triggers-tab.tsx';

/** What every tab body receives. */
export interface CustomizeTabProps {
  projectId: string;
  focused: boolean;
  width: number;
  height: number;
  /** The clock ages render against. A prop, never `Date.now()`. */
  now: number;
  onToast?(message: string, kind?: 'info' | 'error'): void;
  /** True while this tab owns every printable key (an input or a confirm). */
  onInputActive(active: boolean): void;
}

export interface CustomizeShellProps {
  tabs: readonly { id: string; label: string }[];
  activeId: string;
  onActivate(id: string): void;
  focused: boolean;
  width: number;
  height: number;
  /** True while the active tab owns every key. The shell then answers none. */
  inputActive: boolean;
  onBack(): void;
  children?: ReactNode;
}

export function CustomizeShell({
  tabs,
  activeId,
  onActivate,
  focused,
  width,
  inputActive,
  onBack,
  children,
}: CustomizeShellProps) {
  const activeIndex = Math.max(
    tabs.findIndex((tab) => tab.id === activeId),
    0,
  );

  const move = useCallback(
    (step: 1 | -1) => {
      if (tabs.length === 0) return;
      const next = (activeIndex + step + tabs.length) % tabs.length;
      const tab = tabs[next];
      if (tab) onActivate(tab.id);
    },
    [tabs, activeIndex, onActivate],
  );

  useKeyboard((key) => {
    if (!focused || inputActive) return;
    if (matchesCustomizeBinding(key, 'customize.cancel')) return onBack();
    if (matchesCustomizeBinding(key, 'customize.tabNext')) return move(1);
    if (matchesCustomizeBinding(key, 'customize.tabPrev')) return move(-1);
    const index = tabIndexForDigit(key, tabs.length);
    if (index >= 0) {
      const tab = tabs[index];
      if (tab) onActivate(tab.id);
    }
  });

  const bodyWidth = Math.max(width - 1, 0);

  return (
    <box flexDirection="column" width={width}>
      <text>
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          return (
            <span
              key={tab.id}
              fg={active ? theme.fg : theme.dim}
              bg={active ? theme.surface : undefined}
            >
              {` ${index + 1} ${tab.label} `}
            </span>
          );
        })}
      </text>
      <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
      {children}
      <text fg={theme.faint}>{layoutRow('1-5 / [ ] tabs · Esc back', '', bodyWidth)}</text>
    </box>
  );
}

export interface CustomizeScreenProps {
  projectId: string | null;
  /** The account the project belongs to. Carried for the caller's header. */
  accountId: string | null;
  focused: boolean;
  width: number;
  height: number;
  /** Open this tab first. Defaults to Agents. */
  initialTab?: CustomizeTabId;
  /**
   * The Kortix web origin, for the Connectors tab's connect hint. The TUI
   * runs no OAuth flow; it prints the page the user must open. Without it the
   * hint is the path alone.
   */
  webBaseUrl?: string;
  onBack(): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
}

/** How often ages are recomputed. A minute is the smallest unit printed. */
const CLOCK_TICK_MS = 30_000;

export function CustomizeScreen({
  projectId,
  accountId: _accountId,
  focused,
  width,
  height,
  initialTab = 'agents',
  webBaseUrl,
  onBack,
  onToast,
}: CustomizeScreenProps) {
  const [activeId, setActiveId] = useState<CustomizeTabId>(initialTab);
  const [inputActive, setInputActive] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Leaving a tab drops whatever it had open, so the shell never stays deaf
  // because an unmounted tab never reported its input closed.
  const activate = useCallback((id: string) => {
    setInputActive(false);
    setActiveId(id as CustomizeTabId);
  }, []);

  if (!projectId) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>No project selected.</text>
      </box>
    );
  }

  // 3 rows: the tab strip, its rule, and the hint line.
  const bodyHeight = Math.max(height - 3, 1);
  const tabProps: CustomizeTabProps = {
    projectId,
    focused,
    width,
    height: bodyHeight,
    now,
    onToast,
    onInputActive: setInputActive,
  };

  return (
    <CustomizeShell
      tabs={CUSTOMIZE_TABS}
      activeId={activeId}
      onActivate={activate}
      focused={focused}
      width={width}
      height={height}
      inputActive={inputActive}
      onBack={onBack}
    >
      {activeId === 'agents' ? <AgentsTab {...tabProps} /> : null}
      {activeId === 'skills' ? <SkillsTab {...tabProps} /> : null}
      {activeId === 'secrets' ? <SecretsTab {...tabProps} /> : null}
      {activeId === 'triggers' ? <TriggersTab {...tabProps} /> : null}
      {activeId === 'connectors' ? <ConnectorsTab {...tabProps} webBaseUrl={webBaseUrl} /> : null}
    </CustomizeShell>
  );
}
