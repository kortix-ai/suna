import { expect, mock, test } from 'bun:test';
import type { ArtifactDetail } from '@kortix/sdk';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Text', 'Document', 'MutationObserver', 'DOMParser', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'InputEvent', 'Range', 'DOMRect', 'NodeFilter', 'ShadowRoot'] as const) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? browser : key === 'document' ? browser.document : browser[key], configurable: true, writable: true });
}
Object.assign(globalThis, { getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
const react = { ...await import('react') };
const registerRealEffect = react.useEffect;
let holdEffects = false;
let gateNextEffect = false;
let effectRunners: Array<() => void> = [];
const useGatedEffect: typeof registerRealEffect = (setup, dependencies) => {
  const gated = gateNextEffect;
  gateNextEffect = false;
  registerRealEffect(() => {
    if (!gated) return setup();
    const entry: { cancelled: boolean; cleanup: ReturnType<typeof setup> } = { cancelled: false, cleanup: undefined };
    const run = () => { if (!entry.cancelled) entry.cleanup = setup(); };
    if (holdEffects) effectRunners.push(run);
    else run();
    return () => {
      entry.cancelled = true;
      if (typeof entry.cleanup === 'function') entry.cleanup();
    };
  }, dependencies);
};
mock.module('react', () => ({ ...react, useEffect: useGatedEffect, default: { ...react.default, useEffect: useGatedEffect } }));
function releaseEffects() {
  holdEffects = false;
  const pending = effectRunners;
  effectRunners = [];
  for (const run of pending) run();
}

const autosave = { ...await import('./doc-autosave') };
const reads: boolean[] = [];
let saves = 0;
let textReads = 0;
mock.module('./doc-autosave', () => ({ ...autosave, pendingSave: (id: string) => {
  const pending = autosave.pendingSave(id);
  reads.push(!!pending);
  if (holdEffects && reads.length === 1) gateNextEffect = true;
  return pending;
} }));
const sdkReact = await import('@kortix/sdk/react');
const save = { mutateAsync: async () => { saves++; return { entry_version: 'saved' }; } };
mock.module('@kortix/sdk/react', () => ({ ...sdkReact, useArtifactText: (_projectId: string, artifact: ArtifactDetail | null) => {
  if (artifact) textReads++;
  return { data: artifact ? 'Old text.\n' : undefined };
}, useArtifactMutations: () => ({ save }) }));
const { DocEditor } = await import('./doc-editor');

for (const completesBeforeEffects of [true, false]) {
  test(`a pending save renders its outcome when it completes ${completesBeforeEffects ? 'before' : 'after'} passive effects`, async () => {
    reads.length = 0;
    saves = 0;
    textReads = 0;
    holdEffects = true;
    gateNextEffect = false;
    effectRunners = [];
    let finishWrite!: (version: string) => void;
    const id = `handoff-${completesBeforeEffects}`;
    const savedText = 'Saved synthetic text.\n';
    const saver = autosave.createDocSaver({ version: 'old', text: 'Old text.\n' }, {
      artifactId: id,
      write: () => new Promise<string>((resolve) => { finishWrite = resolve; }),
      read: async () => ({ version: 'new', text: savedText }),
      text: () => savedText,
      onStatus: () => {},
      onConflict: () => {},
      isConflict: () => false,
    });
    saver.edited();
    saver.flush();
    const pending = autosave.pendingSave(id)!;
    expect(pending).toBeDefined();
    const container = browser.document.createElement('div');
    browser.document.body.append(container);
    const root = createRoot(container as never);
    const artifact = { artifact_id: id, type: 'doc', entry: 'note.md', path: '/synthetic/note.md', entry_version: 'old', version: { id: null, view_url: 'https://example.invalid/note.md' } } as ArtifactDetail;
    try {
      await react.act(async () => root.render(<DocEditor projectId="synthetic" artifact={artifact} editable onStatus={() => {}} onReload={() => {}} />));
      expect(reads).toEqual([true]);
      expect(effectRunners).toHaveLength(1);
      expect(container.querySelector('.tiptap')).toBeNull();
      if (completesBeforeEffects) {
        await react.act(async () => { finishWrite('new'); await pending; });
        expect(autosave.pendingSave(id)).toBeUndefined();
        expect(reads).toEqual([true]);
      }
      await react.act(async () => releaseEffects());
      if (!completesBeforeEffects) {
        expect(autosave.pendingSave(id)).toBeDefined();
        expect(container.querySelector('.tiptap')).toBeNull();
        await react.act(async () => { finishWrite('new'); await pending; });
      }
      expect(container.querySelector('.tiptap')).not.toBeNull();
      expect(container.textContent).toContain(savedText.trim());
      expect(textReads).toBe(0);
      expect(saves).toBe(0);
    } finally {
      await react.act(async () => root.unmount());
      finishWrite('new');
      saver.close();
      await pending;
      holdEffects = false;
      gateNextEffect = false;
      effectRunners = [];
      container.remove();
    }
  }, 2000);
}
