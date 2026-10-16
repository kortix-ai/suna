/**
 * Who may stop a running turn, and who stopped one. Pure, so the rules have a
 * test.
 *
 * In a shared session only the member who prompted the running turn, the
 * session owner or a project manager may stop it. The server owns the rule:
 * `GET .../turn` answers `can_stop` (`useSession().canStop`), a refused stop
 * answers 403 `not_turn_prompter`, and the message authors carry `stops`, the
 * member who stopped each turn, keyed by the user message that started it.
 * Same rules as web.
 *
 * No React / React Native import.
 */
import type { SessionMessageAuthors } from '@kortix/sdk';

import { participantName } from './participants';

/** The 403 `code` of a stop the server refused. */
export const NOT_TURN_PROMPTER = 'not_turn_prompter';

/**
 * May the viewer stop the running turn? The server's `can_stop`, read through
 * `useSession().canStop`. No answer (no bound runtime, or an SDK without the
 * field) reads as yes: the server still refuses a stop it does not allow.
 */
export function viewerMayStop(runtime: { isBusy: boolean; canStop?: boolean } | null | undefined): boolean {
  return runtime?.canStop !== false;
}

/**
 * The toast for a stop the server refused (403 `not_turn_prompter`): the
 * server's own message, else `fallback`. Null for any other failure, so the
 * caller keeps its "Couldn't stop" toast. The runtime client keeps the status
 * of a failed call and drops the body's `code`, so a 403 alone also counts.
 */
export function stopRefusalMessage(error: unknown, fallback: string): string | null {
  if (!error || typeof error !== 'object') return null;
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown };
  if (code !== NOT_TURN_PROMPTER && status !== 403) return null;
  const text = typeof message === 'string' ? message.trim() : '';
  return text || fallback;
}

/**
 * The name of the member who stopped a turn, when that member is not the
 * viewer; else null. The viewer's own stop stays silent, as on web. An unknown
 * viewer is no guess: null. `messageId` is the user message that started the
 * turn.
 */
export function turnStoppedBy(
  authors: SessionMessageAuthors | undefined,
  viewerId: string | null | undefined,
  messageId: string,
): string | null {
  const stopper = authors?.stops?.[messageId];
  if (stopper?.kind !== 'member' || !viewerId || stopper.user_id === viewerId) return null;
  return participantName(stopper) || null;
}
