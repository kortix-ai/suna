import { afterEach, expect, jest, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const window = new Window();
Object.defineProperties(globalThis, {
  window: { value: window, configurable: true },
  document: { value: window.document, configurable: true },
  navigator: { value: window.navigator, configurable: true },
  getComputedStyle: { value: window.getComputedStyle.bind(window), configurable: true },
  requestAnimationFrame: { value: window.requestAnimationFrame.bind(window), configurable: true },
  cancelAnimationFrame: { value: window.cancelAnimationFrame.bind(window), configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});
const success = mock();
const error = mock();
mock.module('@kortix/ui/toast', () => ({ successToast: success, errorToast: error }));
process.env.NEXT_PUBLIC_LUMEN_DEV_PANELS = '1';
const { CallSnippet } = await import('../../src/components/dev/call-snippet');
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  success.mockClear();
  error.mockClear();
  jest.useRealTimers();
});

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<CallSnippet id="session.delete" defaultOpen />));
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Copy the SDK call"]');
  if (!button) throw new Error('SDK copy button missing');
  return button;
}

test('clipboard denial reports failure, leaves no copied state, and allows retry', async () => {
  const writeText = mock(async (_text: string): Promise<void> => { throw new Error('clipboard denied'); });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const button = await mount();
  await act(async () => button.click());
  expect(error).toHaveBeenCalledWith('Could not copy');
  expect(success).not.toHaveBeenCalled();
  expect(button.hasAttribute('data-copied')).toBe(false);
  writeText.mockImplementation(async () => {});
  await act(async () => button.click());
  expect(success).toHaveBeenCalledWith('SDK call copied');
  expect(button.hasAttribute('data-copied')).toBe(true);
  expect(writeText.mock.calls[0]?.[0] ?? '').toBe(document.querySelector('pre code')?.textContent ?? '');
});

test('missing clipboard reports failure without success feedback', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  const button = await mount();
  await act(async () => button.click());
  expect(error).toHaveBeenCalledWith('Could not copy');
  expect(success).not.toHaveBeenCalled();
  expect(button.hasAttribute('data-copied')).toBe(false);
});

test('a clipboard write completing after unmount creates no timer or feedback', async () => {
  const pending = Promise.withResolvers<void>();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => pending.promise }, configurable: true,
  });
  const button = await mount();
  jest.useFakeTimers();
  act(() => button.click());
  act(() => root?.unmount());
  root = undefined;
  await act(async () => pending.resolve());
  expect(jest.getTimerCount()).toBe(0);
  expect(success).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test('successful copy resets after 1500ms and clears the reset on unmount', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mock(async () => {}) }, configurable: true,
  });
  const button = await mount();
  jest.useFakeTimers();
  await act(async () => button.click());
  expect(button.hasAttribute('data-copied')).toBe(true);
  act(() => jest.advanceTimersByTime(1000));
  await act(async () => button.click());
  act(() => jest.advanceTimersByTime(500));
  expect(button.hasAttribute('data-copied')).toBe(true);
  act(() => jest.advanceTimersByTime(1000));
  expect(button.hasAttribute('data-copied')).toBe(false);
  await act(async () => button.click());
  expect(jest.getTimerCount()).toBe(1);
  act(() => root?.unmount());
  root = undefined;
  expect(jest.getTimerCount()).toBe(0);
});

test('the panel renders nothing unless NEXT_PUBLIC_LUMEN_DEV_PANELS=1 (customers never see it)', async () => {
  process.env.NEXT_PUBLIC_LUMEN_DEV_PANELS = '';
  try {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<CallSnippet id="session.delete" defaultOpen />));
    expect(host.innerHTML).toBe('');
  } finally {
    process.env.NEXT_PUBLIC_LUMEN_DEV_PANELS = '1';
  }
});
