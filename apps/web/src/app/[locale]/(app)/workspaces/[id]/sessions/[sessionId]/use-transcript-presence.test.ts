import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { resolveBootPresentation } from '@kortix/ui/session/status/session-surface';
import { useTranscriptPresence } from './use-transcript-presence';

let renderer: ReactTestRenderer | undefined;
afterEach(() => act(() => renderer?.unmount()));

test('stored history demotes the boot wall without runtime messages or a ready sandbox', () => {
  function Surface({ history }: { history: 'loading' | 'shown' | 'none' }) {
    const hasTranscript = useTranscriptPresence(history);
    return createElement('output', null, resolveBootPresentation({ overlay: 'boot-loader', hasTranscript }));
  }
  act(() => { renderer = create(createElement(Surface, { history: 'loading' })); });
  expect(renderer?.root.findByType('output').children).toEqual(['full-screen']);
  act(() => renderer?.update(createElement(Surface, { history: 'shown' })));
  expect(renderer?.root.findByType('output').children).toEqual(['banner']);
  act(() => renderer?.update(createElement(Surface, { history: 'loading' })));
  expect(renderer?.root.findByType('output').children).toEqual(['banner']);
});

test('an empty or failed history read does not invent a transcript', () => {
  function Surface() {
    return createElement('output', null, String(useTranscriptPresence('none')));
  }
  act(() => { renderer = create(createElement(Surface)); });
  expect(renderer?.root.findByType('output').children).toEqual(['false']);
});
