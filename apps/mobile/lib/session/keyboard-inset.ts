/**
 * keyboard-inset — how far the thread page pads its bottom for the keyboard
 * (KRTX-1672).
 *
 * The inset is the keyboard's live height, folded from every keyboard event.
 * It never multiplies a height read once by the progress: the library's
 * `KeyboardAvoidingView` did, with a height it refreshed only on an open's
 * start event. A thread that mounted after that event (a send from project
 * home, the connecting view swapping to the thread) kept a short height, and
 * the composer stayed under the keyboard until the keyboard opened again.
 *
 * Pure and worklet-safe: `bun test` cannot load native modules.
 */

export type KeyboardPhase = 'start' | 'move' | 'interactive' | 'end';

/**
 * The inset after one keyboard event. A start event carries the height the
 * keyboard moves to, not where it is, so it keeps the current inset.
 */
export function nextKeyboardInset(current: number, phase: KeyboardPhase, height: number): number {
  'worklet';
  return phase === 'start' ? current : Math.max(0, height);
}
