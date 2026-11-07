import { beforeEach, describe, expect, test } from 'bun:test';

import { useComposerPrefillStore } from './composer-prefill-store';

describe('composer prefill store', () => {
  beforeEach(() => useComposerPrefillStore.setState({ prefillByProject: {} }));

  test('a plain prefill only fills the box', () => {
    useComposerPrefillStore.getState().setPrefill('p1', 'Draft the release notes');
    expect(useComposerPrefillStore.getState().consume('p1')).toEqual({ text: 'Draft the release notes' });
  });

  test('a Quick Entry prefill carries submit, and is consumed once', () => {
    useComposerPrefillStore.getState().setPrefill('p1', 'Draft the release notes', { submit: true });
    expect(useComposerPrefillStore.getState().consume('p1')).toEqual({
      text: 'Draft the release notes',
      submit: true,
    });
    expect(useComposerPrefillStore.getState().consume('p1')).toBeNull();
  });

  test("a Chrome panel prefill keeps 'when-ready', so the composer waits until it can send", () => {
    useComposerPrefillStore.getState().setPrefill('p1', 'Summarize this page', { submit: 'when-ready' });
    expect(useComposerPrefillStore.getState().consume('p1')).toEqual({
      text: 'Summarize this page',
      submit: 'when-ready',
    });
  });

  test('prefills stay in their own project', () => {
    useComposerPrefillStore.getState().setPrefill('p1', 'one', { submit: true });
    expect(useComposerPrefillStore.getState().consume('p2')).toBeNull();
    expect(useComposerPrefillStore.getState().consume('p1')?.text).toBe('one');
  });
});
