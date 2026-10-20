import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

/**
 * KRTX-2911: `/cli/authorize` without a pending request shows the
 * `kortix login` command with a copy button. The button copies a command, so
 * it must not be named "Copy code" (the shared button's default).
 */

const labels: Array<string | undefined> = [];
mock.module('@/components/markdown/copy-button', () => ({
  CopyButton: ({ label }: { label?: string }) => {
    labels.push(label);
    return createElement('button', { 'aria-label': label });
  },
}));
const translator = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => translator }));

const { CopyCommand } = await import('./auth-consent');

describe('CopyCommand', () => {
  test('names its button "Copy command", not the shared "Copy code" default', () => {
    labels.length = 0;
    act(() => {
      create(createElement(CopyCommand, { command: 'kortix login' }));
    });
    // `text9a01feecae67` is "Copy command" in every catalog.
    expect(labels).toEqual(['text9a01feecae67']);
  });
});
