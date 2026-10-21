import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { FileSourceProvider, type FileSource } from './file-source';
import { useFileContentState } from './use-file-content-state';

test('a rejected save stays dirty and can be retried', async () => {
  let rejectSave = true;
  let saves = 0;
  const content = { type: 'text' as const, content: 'original', revision: 'a'.repeat(40) };
  const source: FileSource = {
    id: 'save-rejection',
    useFileContent: () => ({ data: content, isLoading: false, error: null, refetch: async () => undefined }),
    useBinaryBlob: () => ({ blobUrl: null, blob: null, isLoading: false, error: null }),
    download: async () => undefined,
    upload: async () => undefined,
    save: async () => { saves++; if (rejectSave) throw new Error('409 conflict'); },
  };
  let state: ReturnType<typeof useFileContentState> | undefined;
  function Probe() {
    state = useFileContentState({ filePath: '/README.txt', readOnly: false, markdownPreview: false });
    return null;
  }
  let root: ReturnType<typeof create> | undefined;
  await act(async () => { root = create(<FileSourceProvider value={source}><Probe /></FileSourceProvider>); });
  try {
    // The hook's beforeunload listener needs a browser event target.
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    await act(async () => { state?.setHasUnsavedChanges(true); });
    await act(async () => { await expect(state?.handleSave('edited')).rejects.toThrow('409 conflict'); });
    expect(state?.hasUnsavedChanges).toBe(true);
    expect(state?.isSaving).toBe(false);
    expect(state?.saveFlash).toBe(false);
    rejectSave = false;
    await act(async () => { await state?.handleSave('edited'); });
    expect(saves).toBe(2);
    expect(state?.hasUnsavedChanges).toBe(false);
  } finally {
    await act(async () => root?.unmount());
  }
});

test('a dirty draft keeps its original revision through a content refetch', async () => {
  let content = { type: 'text' as const, content: 'original', revision: 'a'.repeat(40) };
  const revisions: Array<string | undefined> = [];
  const source: FileSource = {
    id: 'dirty-refetch',
    useFileContent: () => ({ data: content, isLoading: false, error: null, refetch: async () => undefined }),
    useBinaryBlob: () => ({ blobUrl: null, blob: null, isLoading: false, error: null }),
    download: async () => undefined,
    upload: async () => undefined,
    save: async (_path, _file, revision) => { revisions.push(revision); throw new Error('409 conflict'); },
  };
  let state: ReturnType<typeof useFileContentState> | undefined;
  function Probe() {
    state = useFileContentState({ filePath: '/README.txt', readOnly: false, markdownPreview: false });
    return null;
  }
  const view = () => <FileSourceProvider value={source}><Probe /></FileSourceProvider>;
  let root: ReturnType<typeof create> | undefined;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  await act(async () => { root = create(view()); });
  try {
    await act(async () => { state?.handleEditorChange('my draft'); state?.setHasUnsavedChanges(true); });
    content = { type: 'text', content: 'concurrent edit', revision: 'b'.repeat(40) };
    await act(async () => { root?.update(view()); });
    await act(async () => { await expect(state?.handleSave('my draft')).rejects.toThrow('409 conflict'); });
    expect(revisions).toEqual(['a'.repeat(40)]);
    expect(state?.hasUnsavedChanges).toBe(true);
    await act(async () => { state?.handleDiscard(); });
    await act(async () => { state?.setHasUnsavedChanges(true); });
    await act(async () => { await expect(state?.handleSave('new draft')).rejects.toThrow('409 conflict'); });
    expect(revisions).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  } finally {
    await act(async () => root?.unmount());
  }
});
