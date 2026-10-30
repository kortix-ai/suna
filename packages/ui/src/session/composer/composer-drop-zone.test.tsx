import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Container } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}

import { ComposerDropZone, useComposerDropZone } from './composer-drop-zone';

/**
 * The session page's column is one drop zone (`session-chat.tsx`): a file
 * dropped on the transcript or the header attaches to the composer, as a
 * drop on the composer card always did.
 */
type Accept = ((files: File[]) => void) | null;

function Composer({ accept }: { accept: Accept }) {
  useComposerDropZone(accept);
  return <div id="composer" />;
}

function Nested() {
  // A drop target inside the zone that takes the drop itself.
  return <div id="nested" onDrop={(event) => event.preventDefault()} />;
}

function mount(accept: Accept) {
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  act(() => {
    root.render(
      <ComposerDropZone>
        <p id="transcript">
          <span id="turn">A turn</span>
        </p>
        <Nested />
        <Composer accept={accept} />
      </ComposerDropZone>,
    );
  });
  const at = (id: string) => win.document.getElementById(id)!;
  const overlay = () => win.document.querySelector('[data-composer-drop-overlay]') !== null;
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { at, overlay, unmount };
}

const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });

function drag(target: { dispatchEvent(event: unknown): boolean }, type: string, types = ['Files']) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files: types.includes('Files') ? [file] : [], dropEffect: 'none' },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('ComposerDropZone', () => {
  test('a file dropped on the transcript reaches the composer, with the overlay while it is over the page', () => {
    const received: File[][] = [];
    const page = mount((files) => received.push(files));
    try {
      expect(drag(page.at('turn'), 'dragenter').defaultPrevented).toBe(true);
      const over = drag(page.at('turn'), 'dragover');
      expect(over.defaultPrevented).toBe(true);
      expect((over as unknown as { dataTransfer: DataTransfer }).dataTransfer.dropEffect).toBe('copy');
      expect(page.overlay()).toBe(true);
      expect(drag(page.at('turn'), 'drop').defaultPrevented).toBe(true);
      expect(received).toEqual([[file]]);
      expect(page.overlay()).toBe(false);
    } finally {
      page.unmount();
    }
  });

  test('a composer that takes no files leaves the drag unclaimed, so the page refuses it', () => {
    const page = mount(null);
    try {
      expect(drag(page.at('turn'), 'dragenter').defaultPrevented).toBe(false);
      expect(drag(page.at('turn'), 'dragover').defaultPrevented).toBe(false);
      expect(page.overlay()).toBe(false);
      expect(drag(page.at('turn'), 'drop').defaultPrevented).toBe(false);
    } finally {
      page.unmount();
    }
  });

  test('a text drag is not claimed', () => {
    const received: File[][] = [];
    const page = mount((files) => received.push(files));
    try {
      expect(drag(page.at('turn'), 'dragenter', ['text/plain']).defaultPrevented).toBe(false);
      expect(page.overlay()).toBe(false);
      drag(page.at('turn'), 'drop', ['text/plain']);
      expect(received).toEqual([]);
    } finally {
      page.unmount();
    }
  });

  test('a drop a nested target already took is left to it', () => {
    const received: File[][] = [];
    const page = mount((files) => received.push(files));
    try {
      drag(page.at('nested'), 'dragenter');
      drag(page.at('nested'), 'drop');
      expect(received).toEqual([]);
      expect(page.overlay()).toBe(false);
    } finally {
      page.unmount();
    }
  });

  test('moving between children keeps the overlay; leaving the page hides it', () => {
    const page = mount(() => {});
    try {
      drag(page.at('transcript'), 'dragenter');
      drag(page.at('turn'), 'dragenter');
      drag(page.at('transcript'), 'dragleave');
      expect(page.overlay()).toBe(true);
      drag(page.at('turn'), 'dragleave');
      expect(page.overlay()).toBe(false);
    } finally {
      page.unmount();
    }
  });
});
