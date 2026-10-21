import { expect, test } from 'bun:test';
import { FileHeader } from './file-header';
import { act, create } from 'react-test-renderer';
import { FileSourceProvider, type FileSource } from './file-source';
import { useFileContentState } from './use-file-content-state';

test('a rejected save stays dirty and can be retried', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
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
  try {
    await act(async () => { root = create(<FileSourceProvider value={source}><Probe /></FileSourceProvider>); });
    // The hook's beforeunload listener needs a browser event target.
    Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { clearTimeout, setTimeout }) });
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
    try {
      await act(async () => root?.unmount());
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

test('a dirty draft keeps its original revision through a content refetch', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let content = { type: 'text' as const, content: 'original', revision: 'a'.repeat(40) };
  const revisions: Array<string | undefined> = [];
  const savedContents: string[] = [];
  const source: FileSource = {
    id: 'dirty-refetch',
    useFileContent: () => ({ data: content, isLoading: false, error: null, refetch: async () => undefined }),
    useBinaryBlob: () => ({ blobUrl: null, blob: null, isLoading: false, error: null }),
    download: async () => undefined,
    upload: async () => undefined,
    save: async (_path, file, revision) => { savedContents.push(await file.text()); revisions.push(revision); throw new Error('409 conflict'); },
  };
  let state: ReturnType<typeof useFileContentState> | undefined;
  function Probe() {
    state = useFileContentState({ filePath: '/README.txt', readOnly: false, markdownPreview: false });
    return <FileHeader {...state} showHeader filePath="/README.txt" readOnly={false} discardLabel="Discard" headerActions={null} />;
  }
  const view = () => <FileSourceProvider value={source}><Probe /></FileSourceProvider>;
  let root: ReturnType<typeof create> | undefined;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { clearTimeout, setTimeout }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  try {
    await act(async () => { root = create(view()); });
    await act(async () => { state?.handleEditorChange('my draft'); state?.setHasUnsavedChanges(true); });
    content = { type: 'text', content: 'concurrent edit', revision: 'b'.repeat(40) };
    await act(async () => { root?.update(view()); });
    const saveButton = root?.root.findAllByType('button').find((button) => button.props.title?.includes('Save'));
    expect(saveButton).toBeDefined();
    await act(async () => { saveButton?.props.onClick(); });
    expect(savedContents).toEqual(['my draft']);
    expect(state?.latestContentRef.current).toBe('my draft');
    expect(revisions).toEqual(['a'.repeat(40)]);
    expect(state?.hasUnsavedChanges).toBe(true);
    await act(async () => { state?.handleDiscard(); });
    await act(async () => { state?.setHasUnsavedChanges(true); });
    await act(async () => { await expect(state?.handleSave('new draft')).rejects.toThrow('409 conflict'); });
    expect(revisions).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  } finally {
    try {
      await act(async () => root?.unmount());
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  }
});
