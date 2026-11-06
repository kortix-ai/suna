/** Owns the timers of one mounted deep-link listener. Disposal also settles awaited delays. */
export function createDeepLinkScope() {
  let active = true;
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const schedule = (run: () => void, ms: number, cancel = () => {}) => {
    if (!active) { cancel(); return; }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (active) run();
    }, ms);
    timers.set(timer, cancel);
  };
  return {
    get active() { return active; },
    schedule,
    pause: (ms: number) => new Promise<boolean>((resolve) => schedule(() => resolve(true), ms, () => resolve(false))),
    dispose: () => {
      active = false;
      for (const [timer, cancel] of timers) {
        clearTimeout(timer);
        cancel();
      }
      timers.clear();
    },
  };
}
