/** True when `target` takes typed text: an input, a textarea or a contenteditable element. */
export function isTextEntry(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLElement> | null;
  if (!element || typeof element.tagName !== 'string') return false;
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.isContentEditable === true
  );
}
