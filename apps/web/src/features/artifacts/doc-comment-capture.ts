export function captureDocComment<T>(
  start: (() => () => void) | undefined,
  capture: () => Promise<T | undefined>,
  publish: (value: T) => void,
) {
  const finish = start?.();
  let active = true;
  const cancel = () => {
    if (!active) return;
    active = false;
    finish?.();
  };
  const done = (async () => {
    try {
      const value = await capture();
      if (active && value !== undefined) publish(value);
    } finally {
      cancel();
    }
  })();
  return { done, cancel };
}
