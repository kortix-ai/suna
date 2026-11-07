/** The width from which the thread panel sits beside the chat (`xl`; below it the panel covers the chat). */
const THREAD_BESIDE_CHAT_QUERY = '(min-width: 80rem)';

/**
 * A message just sent from the space's chat: its new thread opens on the
 * right, unless the panel would cover the chat (a narrow window: the person
 * stays in the chat, as before) or the person is typing in the open thread's
 * reply box (their typing is not taken away). The chat's composer keeps the
 * focus: the next message can go at once. Pure but for `window`/`document`, which its test passes in.
 */
export function autoOpenThread(sessionId: string, open: (sessionId: string) => void, win: Pick<Window, 'matchMedia'> | undefined = typeof window === 'undefined' ? undefined : window, doc: Pick<Document, 'activeElement'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  if (!win || !win.matchMedia(THREAD_BESIDE_CHAT_QUERY).matches) return false;
  const active = doc?.activeElement as Element | null | undefined;
  if (active?.closest?.('[data-thread-panel]')) return false;
  open(sessionId);
  return true;
}

