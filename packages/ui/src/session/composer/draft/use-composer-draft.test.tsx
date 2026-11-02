import type { JSONContent } from '@tiptap/core';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { UiProvider } from '../../../providers/ui-provider';
import type { ComposerEditorHandle } from '../editor/composer-editor';
import type { DraftScope, StoredDraft } from './composer-draft';
import { readDraft } from './composer-draft-store';
import { useComposerDraft, type UseComposerDraftResult } from './use-composer-draft';

const window = new Window({ url: 'http://localhost' });
const originals = ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  localStorage: window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
afterAll(() => {
  for (const { key, descriptor } of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.happyDOM.abort();
});
let renderer: ReactTestRenderer | undefined;
function mountedRenderer(): ReactTestRenderer {
  if (!renderer) throw new Error('Draft probe is not mounted');
  return renderer;
}
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  window.localStorage.clear();
});
const viewer = () => 'synthetic-viewer';
const scope: DraftScope = { kind: 'project', projectId: 'synthetic-project' };
const sessionScope: DraftScope = {
  kind: 'session',
  sessionId: 'synthetic-session',
};
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function harness(draftScope: DraftScope = scope) {
  let document: JSONContent = doc('submitted prompt');
  let quotes: readonly string[] = ['quoted passage'];
  let api: UseComposerDraftResult;
  const restored: StoredDraft[] = [];
  const editor: ComposerEditorHandle = {
    getContent: () => ({ text: '', mentions: [] }),
    getDocument: () => document,
    setContent: (text) => {
      document = doc(text);
    },
    setDocument: (next) => {
      document = next;
    },
    insertAtCursor: () => {},
    clear: () => {
      document = { type: 'doc', content: [{ type: 'paragraph' }] };
    },
    focus: () => {},
    isEmpty: () => false,
    getElement: () => null,
  };
  const editorRef = { current: editor };
  function Probe() {
    api = useComposerDraft({
      scope: draftScope,
      editorRef,
      editorReady: true,
      attachedFiles: [],
      quotes,
      hasPrefill: false,
      onRestore: (draft) => restored.push(draft),
    });
    return null;
  }
  const render = () => (
    <UiProvider useViewerId={viewer}>
      <Probe />
    </UiProvider>
  );
  act(() => {
    renderer = create(render());
  });
  return {
    type(text: string) {
      document = doc(text);
      act(() => api.handleDocChange(document, false));
    },
    submit() {
      act(() => api.clearSavedDraft());
    },
    removeQuotes() {
      quotes = [];
      act(() => mountedRenderer().update(render()));
    },
    addQuote() {
      quotes = ['new unsent quote'];
      act(() => mountedRenderer().update(render()));
    },
    hide() {
      window.dispatchEvent(new window.Event('pagehide'));
    },
    leave() {
      act(() => mountedRenderer().unmount());
      renderer = undefined;
    },
    restore() {
      editorRef.current.isEmpty = () => true;
      act(() => {
        renderer = create(render());
      });
      return restored;
    },
  };
}

test('submitted retained editor is not saved again when send removes accessories', () => {
  const composer = harness();
  composer.type('submitted prompt');
  composer.submit();
  expect(readDraft(scope, viewer())).toBeNull();
  composer.removeQuotes();
  composer.leave(); // Flushes pending writes, as navigation/pagehide does.
  expect(readDraft(scope, viewer())).toBeNull();
  expect(composer.restore()).toEqual([]);
});

test('unsent session draft survives unmount and refresh', () => {
  const composer = harness(sessionScope);
  composer.type('unsent session draft');
  composer.leave();
  expect(readDraft(sessionScope, viewer())?.doc).toEqual(doc('unsent session draft'));
  expect(composer.restore()[0]?.doc).toEqual(doc('unsent session draft'));
});

test('typing after submission creates a new persistent draft', () => {
  const composer = harness();
  composer.type('submitted prompt');
  composer.submit();
  composer.removeQuotes();
  composer.type('next unsent prompt');
  composer.leave();
  expect(readDraft(scope, viewer())?.doc).toEqual(doc('next unsent prompt'));
});

test('accessories added after submission persist without the submitted editor text', () => {
  const composer = harness();
  composer.type('submitted prompt');
  composer.submit();
  composer.removeQuotes();
  composer.addQuote();
  composer.hide();
  const saved = readDraft(scope, viewer());
  expect(saved?.quotes).toEqual(['new unsent quote']);
  expect(saved?.doc).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
});

test('pagehide does not resurrect a submitted draft after accessory cleanup', () => {
  const composer = harness();
  composer.type('submitted prompt');
  composer.submit();
  composer.removeQuotes();
  composer.hide();
  expect(readDraft(scope, viewer())).toBeNull();
});

test('a stored session draft is not restored in project or other session composers', () => {
  const source = harness(sessionScope);
  source.type('private unsent session draft');
  source.leave();
  expect(readDraft(sessionScope, viewer())?.doc).toEqual(doc('private unsent session draft'));

  for (const destination of [
    scope,
    {
      kind: 'session',
      sessionId: 'other-synthetic-session',
    } satisfies DraftScope,
  ]) {
    const composer = harness(destination);
    composer.leave();
    expect(composer.restore()).toEqual([]);
    composer.leave();
    expect(readDraft(destination, viewer())).toBeNull();
  }
  const original = harness(sessionScope);
  original.leave();
  expect(original.restore()[0]?.doc).toEqual(doc('private unsent session draft'));
});
