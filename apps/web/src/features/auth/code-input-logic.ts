export const CODE_LENGTH = 6;

/**
 * Pure editing model for the six-box code input. Kept DOM-free so the
 * type / type-over / autofill / paste / backspace behaviors are unit-testable.
 */

export type CodeEdit = { next: string; focus: number };

export function insertDigits(value: string, index: number, digits: string): CodeEdit {
  const next = (value.slice(0, index) + digits + value.slice(index + digits.length)).slice(
    0,
    CODE_LENGTH,
  );
  return { next, focus: Math.min(index + digits.length, CODE_LENGTH - 1) };
}

/**
 * Interpret whatever the browser left in one box after an input event.
 *
 * - a single digit: plain typing
 * - two digits where one is the box's old value: typing over an occupied box
 *   (the old and new char arrive together in caret order) — keep the new one
 * - anything longer: OTP autofill or paste routed through the input event —
 *   the whole sequence is written starting at this box, never truncated to
 *   the last character
 */
export function applyBoxInput(value: string, index: number, raw: string): CodeEdit | null {
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 2 && value[index] && digits.includes(value[index])) {
    const stripped = digits.replace(value[index], '');
    if (stripped.length === 1) digits = stripped;
  }

  return insertDigits(value, index, digits);
}

export function applyBackspace(value: string, index: number): CodeEdit {
  if (value[index]) {
    return { next: value.slice(0, index) + value.slice(index + 1), focus: index };
  }
  const previous = Math.max(0, index - 1);
  return { next: value.slice(0, previous) + value.slice(index), focus: previous };
}
