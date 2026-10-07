/**
 * Browser presence of one session view: a person who used the page recently,
 * not an open tab (KRTX-1729).
 *
 * The server keeps a present viewer's lease and, while it exists, keeps the
 * session's computer awake. A visible tab used to count as present forever, so
 * a tab left open overnight kept the computer up until its 24 h cap. Now a
 * visible tab with no pointer, keyboard, wheel, touch, scroll or focus input
 * for {@link PRESENCE_INPUT_WINDOW_MS} reports absent; the server drops its
 * lease, and the computer stops after its idle grace. The next input reports
 * present at once.
 */

/** No input for this long: the person has left. */
export const PRESENCE_INPUT_WINDOW_MS = 10 * 60_000;
/** How often the view re-checks, and renews while its stream is down. */
export const PRESENCE_CHECK_MS = 30_000;

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll', 'focus'] as const;

export interface HumanPresenceEnv {
  doc: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  win: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'>;
  now?: () => number;
}

/**
 * Report presence through `send` on every change, and every check while the
 * stream is down (the renewal the stream does while it is up). Returns stop,
 * which reports absent.
 */
export function watchHumanPresence(
  env: HumanPresenceEnv,
  send: (active: boolean) => void,
  streamConnected: () => boolean,
): () => void {
  const now = env.now ?? Date.now;
  // Opening the view is input.
  let lastInput = now();
  let sent: boolean | null = null;
  const present = () => !env.doc.hidden && now() - lastInput < PRESENCE_INPUT_WINDOW_MS;
  const report = (renew = false) => {
    const active = present();
    if (renew || active !== sent) {
      sent = active;
      send(active);
    }
  };
  const onInput = () => {
    lastInput = now();
    if (sent !== true) report();
  };
  const onVisibility = () => {
    if (!env.doc.hidden) lastInput = now();
    report();
  };

  report();
  const interval = env.win.setInterval(() => report(present() && !streamConnected()), PRESENCE_CHECK_MS);
  // Capture: scroll and focus do not bubble, and a page may stop propagation.
  for (const type of INPUT_EVENTS) env.win.addEventListener(type, onInput, { capture: true, passive: true });
  env.doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    env.win.clearInterval(interval);
    for (const type of INPUT_EVENTS) env.win.removeEventListener(type, onInput, { capture: true });
    env.doc.removeEventListener('visibilitychange', onVisibility);
    send(false);
  };
}
