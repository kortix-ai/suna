import { describe, expect, test } from 'bun:test';

import {
  TOAST_DEFAULT_DURATION_MS,
  resolveToastMessage,
  toastDuration,
  toastErrorMessage,
  toastHaptic,
  toastKeepsCloseButton,
} from './toast-model';

describe('toastDuration', () => {
  test('success, error, info and warning stay 4 s', () => {
    for (const type of ['success', 'error', 'info', 'warning'] as const) {
      expect(toastDuration(type)).toBe(TOAST_DEFAULT_DURATION_MS);
    }
    expect(TOAST_DEFAULT_DURATION_MS).toBe(4000);
  });

  test('loading stays until it resolves or is dismissed', () => {
    expect(toastDuration('loading')).toBe(Infinity);
  });

  test('an explicit positive duration wins; zero or negative is ignored', () => {
    expect(toastDuration('error', 8000)).toBe(8000);
    expect(toastDuration('success', Infinity)).toBe(Infinity);
    expect(toastDuration('info', 0)).toBe(TOAST_DEFAULT_DURATION_MS);
    expect(toastDuration('loading', -1)).toBe(Infinity);
  });
});

describe('toastHaptic', () => {
  test('success, error and warning buzz with their own pattern; info and loading are silent', () => {
    expect(toastHaptic('success')).toBe('success');
    expect(toastHaptic('error')).toBe('error');
    expect(toastHaptic('warning')).toBe('warning');
    expect(toastHaptic('info')).toBeNull();
    expect(toastHaptic('loading')).toBeNull();
  });
});

describe('messages', () => {
  test('toastErrorMessage matches web: Error message, string, else a generic line', () => {
    expect(toastErrorMessage(new Error('Boom'))).toBe('Boom');
    expect(toastErrorMessage('Nope')).toBe('Nope');
    expect(toastErrorMessage({ code: 1 })).toBe('An error occurred');
    expect(toastErrorMessage(new Error(''))).toBe('An error occurred');
  });

  test('resolveToastMessage takes a string or a function of the result', () => {
    expect(resolveToastMessage('Done', 3)).toBe('Done');
    expect(resolveToastMessage((n: number) => `${n} files`, 3)).toBe('3 files');
  });
});

describe('toastKeepsCloseButton', () => {
  test('a toast that never leaves on its own keeps the close button', () => {
    expect(toastKeepsCloseButton(toastDuration('loading'))).toBe(true);
    expect(toastKeepsCloseButton(toastDuration('warning', Infinity))).toBe(true);
  });

  test('a timed toast has none — the countdown and the swipe dismiss it', () => {
    expect(toastKeepsCloseButton(toastDuration('success'))).toBe(false);
    expect(toastKeepsCloseButton(toastDuration('error', 10_000))).toBe(false);
  });
});
