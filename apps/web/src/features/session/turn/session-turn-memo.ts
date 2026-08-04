import type { SessionTurnProps } from '../session-chat';

/**
 * The `memo` comparator for `SessionTurn`, kept in its own pure module rather
 * than inlined next to the component, for one reason: it has to be testable.
 *
 * apps/web renders component tests through `renderToStaticMarkup` — there is no
 * RTL, jsdom or happy-dom in the dependency set. Under static rendering
 * `React.memo` is inert: nothing re-renders, so "did the memo skip this turn?"
 * cannot be observed. A pure comparator moves that decision into a plain
 * function which `bun test` can assert directly, with no new dependency and no
 * change to how the component renders.
 *
 * The key list is exhaustive ON PURPOSE. A prop added to `SessionTurnProps` but
 * left out of it would compare as equal forever, and the turn would silently
 * stop updating for that prop. `Record<keyof SessionTurnProps, true>` makes that
 * a compile error instead of a runtime mystery: every key is required, and no
 * extra key is allowed.
 */
const COMPARED_KEYS: Record<keyof SessionTurnProps, true> = {
  turn: true,
  isLastUserTurn: true,
  isPlanAnchor: true,
  sessionId: true,
  sessionStatus: true,
  permissions: true,
  questions: true,
  agentNames: true,
  isFirstTurn: true,
  isBusy: true,
  isCompaction: true,
  providers: true,
  commandMessages: true,
  commands: true,
  disableToolNavigation: true,
  onPermissionReply: true,
  onRewind: true,
  rewindDisabled: true,
};

const KEYS = Object.keys(COMPARED_KEYS) as (keyof SessionTurnProps)[];

export function sessionTurnPropsAreEqual(prev: SessionTurnProps, next: SessionTurnProps): boolean {
  for (const key of KEYS) {
    if (!Object.is(prev[key], next[key])) return false;
  }
  return true;
}
