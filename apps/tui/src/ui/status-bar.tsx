import type { ReactNode } from 'react';

import { theme } from '../theme.ts';

export interface StatusBarProps {
  /** Left side: state. A spinner, a phase, an error word. */
  left?: ReactNode;
  /** Right side: key hints, printed dim. */
  right?: string;
}

/** The single bottom row. One line, never wraps. */
export function StatusBar({ left, right }: StatusBarProps) {
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      height={1}
      backgroundColor={theme.bg}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row">{left}</box>
      <text fg={theme.faint}>{right ?? ''}</text>
    </box>
  );
}
