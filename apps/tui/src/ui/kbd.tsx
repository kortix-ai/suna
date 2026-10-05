import { theme } from '../theme.ts';

export interface KbdProps {
  /** Printed chord, e.g. `Ctrl+P`. Use `formatChord` from keymap.ts. */
  keys: string;
  /** What the chord does, printed after it. */
  label?: string;
}

/** One key hint. The status bar and the help overlay are made of these. */
export function Kbd({ keys, label }: KbdProps) {
  return (
    <text>
      <span fg={theme.fg}>{keys}</span>
      {label ? <span fg={theme.faint}>{` ${label}`}</span> : null}
    </text>
  );
}
