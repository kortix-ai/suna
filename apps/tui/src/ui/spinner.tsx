import { useEffect, useState } from 'react';

import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, theme } from '../theme.ts';

export interface SpinnerProps {
  /** Text after the frame, e.g. `working · 12s`. */
  label?: string;
  /** Stop the animation without unmounting (keeps the row height stable). */
  active?: boolean;
}

/** One-character braille spinner. The only animation in the app. */
export function Spinner({ label, active = true }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [active]);
  const glyph = active ? SPINNER_FRAMES[frame] : ' ';
  return (
    <text fg={theme.dim}>
      {glyph}
      {label ? ` ${label}` : ''}
    </text>
  );
}
