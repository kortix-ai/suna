/**
 * SessionThreadTitle — the floating thread header's centred title, sitting
 * between the hamburger and the right-side controls (`FloatingMenuButton`'s
 * `title` slot, `SessionPage.tsx`). The session name only: no status or time
 * line under it (Jay, 2026-09-23) — with one exception: while live updates are
 * paused, a 12pt muted `status` line reads "Last update 6 min ago" (COR-144),
 * so a frozen thread never looks idle. Title (20pt line) + status (16pt line)
 * fit the header's 40pt row.
 *
 * Title: 16pt `font-roobert-medium`, one line, truncates. Tap opens the
 * session's rename flow — the SAME flow the "···" sheet's Rename row opens
 * (`SessionActionsSheet` → `SessionRenameForm`), never a second
 * implementation. `onPress` is omitted while that flow has nowhere to go yet
 * (no project session resolved) — the same guard `ProjectHeaderActions`'s
 * `···` already uses (`ProjectScreen.tsx`'s `activeProjectSession`).
 */
import * as React from 'react';

import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Text } from '@/components/ui/text';

interface SessionThreadTitleProps {
  title: string;
  /** Opens the rename flow. Omit to disable the tap (title reads inert). */
  onPress?: () => void;
  /** One muted line under the title; only "Last update … ago" today. */
  status?: string | null;
}

/**
 * A `PressableSurface`, not a `Button`: the title is a text tap target, not a
 * button shape, and a Button takes no size or padding classes. It is as wide
 * as its text (`FloatingMenuButton` centres and shrinks it) and dims while
 * pressed.
 */
export function SessionThreadTitle({ title, onPress, status }: SessionThreadTitleProps) {
  return (
    <PressableSurface
      disabled={!onPress}
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10 }}
      accessibilityRole={onPress ? 'button' : 'header'}
      accessibilityLabel={status ? `${title}, ${status}` : title}
      accessibilityHint={onPress ? 'Opens rename' : undefined}
      // Content width, not `flex-1`: `FloatingMenuButton` sizes and centres
      // it, and shrinks it so the title truncates. 40pt tall: the header row.
      className="min-h-10 items-center justify-center"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <Text
        className={`max-w-full font-roobert-medium text-base text-foreground${status ? ' leading-5' : ''}`}
        numberOfLines={1}>
        {title}
      </Text>
      {status ? (
        <Text variant="muted" className="max-w-full text-xs leading-4" numberOfLines={1}>
          {status}
        </Text>
      ) : null}
    </PressableSurface>
  );
}
