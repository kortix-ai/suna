type UnloadTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Warn before the tab unloads while a Send holds its prompt POST on uploads.
 * A held send exists from its `whenReady` call until that promise settles. An
 * ordinary send in flight never warns.
 */
export function createHeldSendGuard(target: UnloadTarget | undefined) {
  let held = 0;
  const warn = (event: Event) => {
    event.preventDefault();
    // Older Chromium builds show the prompt only when this legacy field is set.
    (event as BeforeUnloadEvent).returnValue = '';
  };
  return function hold<T>(work: Promise<T>): Promise<T> {
    if (!target) return work;
    if (held++ === 0) target.addEventListener('beforeunload', warn);
    const release = () => {
      if (--held === 0) target.removeEventListener('beforeunload', warn);
    };
    work.then(release, release);
    return work;
  };
}

export const holdUntilSent = createHeldSendGuard(
  typeof window === 'undefined' ? undefined : window,
);
