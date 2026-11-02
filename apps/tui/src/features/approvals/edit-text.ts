/**
 * One-line text entry for the Approvals inputs, driven by raw key events.
 *
 * `ui/` has no input primitive; `ui/picker.tsx` extends its filter the same
 * way. Pure so the editing rules are asserted without a renderer.
 */

import type { KeyEvent } from '@opentui/core';

/** The text after `key`, or `null` when `key` is not an editing key. */
export function editText(value: string, key: KeyEvent): string | null {
  if (key.name === 'backspace') return value.slice(0, -1);
  if (key.ctrl && key.name === 'u') return '';
  if (key.ctrl || key.meta || key.option) return null;
  const seq = key.sequence;
  if (!seq) return null;
  // A paste arrives as one multi-character sequence; a control byte never edits.
  for (const char of seq) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value + seq;
}
