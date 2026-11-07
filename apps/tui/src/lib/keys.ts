import type { KeyEvent } from '@opentui/core';

/** A printable character from a key event, or null. */
export function printableKey(key: KeyEvent): string | null {
  if (key.ctrl || key.option || key.meta || !key.sequence || key.sequence.length !== 1) return null;
  const code = key.sequence.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f ? key.sequence : null;
}
