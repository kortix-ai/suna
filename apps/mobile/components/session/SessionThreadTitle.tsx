/**
 * SessionThreadTitle — the floating thread header's centred title, sitting
 * between the hamburger and the right-side controls (`FloatingMenuButton`'s
 * `title` slot, `SessionPage.tsx`). The session name only: no status or time
 * line under it (Jay, 2026-09-23).
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
}

/**
 * A `PressableSurface`, not a `Button`: the title is a text tap target, not a
 * button shape, and a Button takes no size or padding classes. It fills the
 * header's title column (`FloatingMenuButton`) and dims while pressed.
 */
export function SessionThreadTitle({ title, onPress }: SessionThreadTitleProps) {
  return (
    <PressableSurface
      disabled={!onPress}
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10 }}
      accessibilityRole={onPress ? 'button' : 'header'}
      accessibilityLabel={title}
      accessibilityHint={onPress ? 'Opens rename' : undefined}
      className="flex-1 items-center justify-center"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <Text className="max-w-full font-roobert-medium text-base text-foreground" numberOfLines={1}>
        {title}
      </Text>
    </PressableSurface>
  );
}
