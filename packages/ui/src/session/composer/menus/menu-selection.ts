/**
 * Pure selection arithmetic for the `@` mention menu and `/` slash menu.
 * Extracted so keyboard-navigation math is testable without mounting a
 * component, and so the list can be re-derived during render instead of
 * chasing it with an effect (see `clampSelection`).
 */

/** Move the highlight, wrapping at both ends. */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

/**
 * Keep the highlight inside the list.
 *
 * Derived during render, which is what lets the clamp effect at
 * session-chat-input.tsx:704-708 be deleted rather than ported.
 */
export function clampSelection(current: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(current, 0), length - 1);
}
