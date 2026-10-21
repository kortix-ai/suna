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
  await act(async () => { root = create(createElement(FileSourceProvider, { value: source, children: createElement(Probe) })); });
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
