'use client';

import { useEffect, useState } from 'react';

/**
 * How long a streaming block's text must hold still before it is rendered in
 * full: highlighted for code, drawn for a Mermaid diagram.
 *
 * The block that is still arriving changes on every paced render, and
 * tokenizing it each time was the dominant cost of streaming a code answer
 * (Shiki re-ran over the whole block per delta batch, and its cache never hit
 * because the key moved with the text). A diagram re-ran `mermaid.render` per
 * batch and flickered between its placeholder, an error card for each
 * half-written prefix, and the SVG. A block renders its plain form while it
 * grows and its full form once it stops — when its fence closes and the
 * message moves on, or at once when the stream ends.
 */
export const CODE_SETTLE_MS = 400;

/** `value` once it has held still for `delayMs` while `active`; `value` when not active; else null. */
export function useSettledValue(value: string, active: boolean, delayMs: number): string | null {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, active, delayMs]);
  if (!active) return value;
  return settled === value ? value : null;
}
