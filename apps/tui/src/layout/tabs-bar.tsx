/**
 * The session tabs: the sessions opened in this run, one row, top or bottom.
 *
 * A module (`layout/ui-prefs.ts`, `/tabs`). Opening a session adds its tab;
 * `/close` removes the open one and lands on its neighbour; `Alt+[` / `Alt+]`
 * step through them. The model is opencode's (`session-tabs-model.ts`): tabs
 * are the sessions you are working in, not every session of the project —
 * that list is `/sessions`.
 *
 * Pure view: `app.tsx` owns the tab list and the titles.
 */

import { theme } from '../theme.ts';

export interface Tab {
  sessionId: string;
  title: string;
  /** A turn is running in it. */
  busy?: boolean;
}

export interface TabsBarProps {
  tabs: readonly Tab[];
  activeId: string | null;
  width: number;
}

export const TAB_MAX_WIDTH = 26;
export const TAB_MIN_WIDTH = 10;

/** `Open: open tabs [start, end)` — a window that keeps the active tab on screen. */
export function visibleTabs(
  count: number,
  activeIndex: number,
  tabWidth: number,
  width: number,
): { start: number; end: number } {
  const fit = Math.max(Math.floor((width - 4) / tabWidth), 1);
  if (count <= fit) return { start: 0, end: count };
  const half = Math.floor(fit / 2);
  const start = Math.min(Math.max((activeIndex < 0 ? 0 : activeIndex) - half, 0), count - fit);
  return { start, end: start + fit };
}

export function tabLabel(index: number, title: string, width: number): string {
  const text = ` ${index + 1} ${title}`;
  const room = width - 1;
  return (text.length > room ? `${text.slice(0, room - 1)}…` : text).padEnd(width);
}

export function TabsBar({ tabs, activeId, width }: TabsBarProps) {
  if (tabs.length === 0) {
    return (
      <box height={1} paddingLeft={1} flexShrink={0}>
        <text fg={theme.faint} wrapMode="none">
          No open sessions. /sessions opens one, a prompt starts one.
        </text>
      </box>
    );
  }
  const tabWidth = Math.max(
    Math.min(Math.floor((width - 4) / tabs.length), TAB_MAX_WIDTH),
    TAB_MIN_WIDTH,
  );
  const activeIndex = tabs.findIndex((tab) => tab.sessionId === activeId);
  const { start, end } = visibleTabs(tabs.length, activeIndex, tabWidth, width);
  return (
    <box flexDirection="row" height={1} flexShrink={0} backgroundColor={theme.bg}>
      {start > 0 ? <text fg={theme.faint} wrapMode="none">{`‹${start} `}</text> : null}
      {tabs.slice(start, end).map((tab, offset) => {
        const index = start + offset;
        const active = tab.sessionId === activeId;
        return (
          <text
            key={tab.sessionId}
            fg={active ? theme.fg : theme.dim}
            bg={active ? theme.surface : undefined}
            wrapMode="none"
          >
            {active ? (
              <b>{tabLabel(index, tab.title, tabWidth)}</b>
            ) : (
              tabLabel(index, tab.title, tabWidth)
            )}
          </text>
        );
      })}
      {end < tabs.length ? (
        <text fg={theme.faint} wrapMode="none">{` ${tabs.length - end}›`}</text>
      ) : null}
    </box>
  );
}
