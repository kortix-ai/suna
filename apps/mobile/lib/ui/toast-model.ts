/**
 * Toast rules the app still owns (COR-106).
 *
 * `sonner-native` (https://sonner-native.netlify.app, Jay 2026-09-22) owns the
 * stack, the swipe, the timers, the layout and the animation. What is left
 * here is what belongs to Kortix: how long a toast stays, which buzz it fires,
 * and the two message helpers the promise API needs. Pure and tested, so the
 * rules cannot drift into the component.
 */

import type { AppIcon } from '@/lib/icons';

export type ToastType = 'success' | 'error' | 'info' | 'warning' | 'loading';

export interface ToastAction {
  label: string;
  onPress: () => void;
  /**
   * `link` (default): a blue ghost button, like web's toast actions.
   * `undo`: the neutral filled key web's undo toast carries.
   */
  kind?: 'link' | 'undo';
}

/** The thing a toast is about: its icon leads the toast, badged with the status. */
export interface ToastEntity {
  icon: AppIcon;
  label: string;
}

export interface ToastOptions {
  /** Pass an existing id to update that toast in place (loading → done). */
  id?: string;
  /** Second line, muted. */
  description?: string;
  /** Milliseconds on screen. `Infinity` keeps it until dismissed. */
  duration?: number;
  /** One button under the text. A press runs `onPress`, then dismisses. */
  action?: ToastAction;
  /** A schedule, a session…: its icon leads (status badged on it), its name is the second line. */
  entity?: ToastEntity;
}

/**
 * The toast's second line. With an entity, its name comes first and the
 * description follows on the next line (web: title, then subject, then detail).
 */
export function toastDescription(options?: Pick<ToastOptions, 'entity' | 'description'>): string | undefined {
  const lines = [options?.entity?.label, options?.description].filter((line): line is string => !!line);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

// ── Timing ──
/** Sonner's default: 4s. */
export const TOAST_DEFAULT_DURATION_MS = 4000;
/** Newest in front; a fourth pushes the oldest out. */
export const TOAST_MAX_VISIBLE = 3;
/** Gap between toasts when the stack is expanded, and below the safe-area top. */
export const TOAST_GAP = 8;
/** Widest a toast gets (tablets); phones use the full width minus the side gutter. */
export const TOAST_MAX_WIDTH = 440;

/** How long a toast stays. A loading toast waits for its update or a dismiss. */
export function toastDuration(type: ToastType, override?: number): number {
  if (override !== undefined && override > 0) return override;
  return type === 'loading' ? Infinity : TOAST_DEFAULT_DURATION_MS;
}

/**
 * Does this toast draw a close button? Only one that never leaves on its own
 * (a loading toast, or `duration: Infinity`). A timed toast is dismissed by
 * its own countdown or a swipe, so the X is noise (Jay, 2026-09-22).
 */
export function toastKeepsCloseButton(duration: number): boolean {
  return !Number.isFinite(duration);
}

export type ToastHaptic = 'success' | 'error' | 'warning' | null;

/** The notification haptic a toast fires when it appears. Info and loading are silent. */
export function toastHaptic(type: ToastType): ToastHaptic {
  if (type === 'success' || type === 'error' || type === 'warning') return type;
  return null;
}

/** A thrown value as a sentence, for a promise toast with no `error` message. */
export function toastErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'An error occurred';
}

/** A promise toast's success/error slot: a string, or a function of the result. */
export function resolveToastMessage<V>(message: string | ((value: V) => string), value: V): string {
  return typeof message === 'function' ? message(value) : message;
}
