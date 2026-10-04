/**
 * `ComposerAttachmentTiles`: a progress tick re-renders only its own tile, and
 * a composer re-render with the same uploads (a keystroke) re-renders none.
 */
import { beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

const tileRenders: Record<string, number> = {};
const rings: Record<string, number | undefined> = {};
const removeButtons: Record<string, () => void> = {};
const scrims: Record<string, (() => void) | undefined> = {};

mock.module('react-native', () => ({
  ScrollView: ({ children }: any) => children,
  View: ({ children }: any) => children,
}));
mock.module('./attachment-tile', () => ({
  AttachmentTile: ({ filename, corner, overlay }: any) => {
    tileRenders[filename] = (tileRenders[filename] ?? 0) + 1;
    rings[filename] = corner?.props.value;
    scrims[filename] = overlay ? (overlay.props.onRetry ?? (() => {})) : undefined;
    return null;
  },
  UploadProgressRing: () => null,
  AttachmentFailureScrim: () => null,
  AttachmentRemoveButton: ({ filename, onRemove }: any) => {
    removeButtons[filename] = onRemove;
    return null;
  },
}));

let ComposerAttachmentTiles: typeof import('./composer-attachment-tiles').ComposerAttachmentTiles;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ComposerAttachmentTiles } = await import('./composer-attachment-tiles'));
});
beforeEach(() => {
  for (const record of [tileRenders, rings, removeButtons, scrims]) for (const key of Object.keys(record)) delete record[key];
});

const files = [
  { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', isImage: false },
  { uri: 'file:///b.pdf', name: 'b.pdf', mimeType: 'application/pdf', isImage: false },
] as any[];

function liveSource(initial: number) {
  let progress: number | undefined = initial;
  const listeners = new Set<() => void>();
  return {
    live: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getProgress: () => progress,
    },
    set(value: number | undefined) {
      progress = value;
      for (const listener of listeners) listener();
    },
  };
}

test('a progress tick re-renders only its tile; a parent re-render with the same uploads renders none', async () => {
  const a = liveSource(10);
  const uploads = { 0: { progress: 10, live: a.live }, 1: { progress: 0 } };
  const removed: number[] = [];
  let tree: any;
  // A new `onRemove` each render, the way `composer.tsx` passes it.
  const render = () => <ComposerAttachmentTiles files={files} uploads={uploads} onRemove={(i) => removed.push(i)} />;
  await act(async () => {
    tree = create(render());
  });
  expect(rings).toEqual({ 'a.pdf': 10, 'b.pdf': 0 });
  expect(tileRenders).toEqual({ 'a.pdf': 1, 'b.pdf': 1 });

  await act(async () => a.set(40));
  expect(rings['a.pdf']).toBe(40);
  expect(tileRenders).toEqual({ 'a.pdf': 2, 'b.pdf': 1 });

  // A keystroke: the composer re-renders with the same files and uploads.
  await act(async () => tree.update(render()));
  expect(tileRenders).toEqual({ 'a.pdf': 2, 'b.pdf': 1 });

  // Remove still reaches the latest `onRemove`, with the tile's index.
  removeButtons['b.pdf']();
  expect(removed).toEqual([1]);

  // The upload finished: the ring goes.
  await act(async () => a.set(undefined));
  expect(rings['a.pdf']).toBeUndefined();
  await act(async () => tree.unmount());
});

test('a failed entry shows the scrim with its Retry and no ring', async () => {
  let retried = 0;
  const uploads = { 0: { failed: true, onRetry: () => retried++ } };
  let tree: any;
  await act(async () => {
    tree = create(<ComposerAttachmentTiles files={[files[0]]} uploads={uploads} onRemove={() => {}} />);
  });
  expect(rings['a.pdf']).toBeUndefined();
  scrims['a.pdf']?.();
  expect(retried).toBe(1);
  await act(async () => tree.unmount());
});
