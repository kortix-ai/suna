import { describe, expect, test } from 'bun:test';
import {
  PRINT_PASSTHROUGH_ATTR,
  PRINT_ROOT_ATTR,
  type PrintChainNode,
  clearPrintChain,
  markPrintChain,
} from './print-chain';

/**
 * `apps/web` registers no jsdom/happy-dom for `bun test`, so the tree is built
 * out of plain objects that satisfy `PrintChainNode`. That is the whole reason
 * the module takes a structural type instead of `HTMLElement`.
 */
interface FakeNode extends PrintChainNode {
  id: string;
  attrs: Set<string>;
  parentElement: FakeNode | null;
}

function node(id: string, parentElement: FakeNode | null = null): FakeNode {
  const attrs = new Set<string>();
  return {
    id,
    attrs,
    parentElement,
    setAttribute: (name: string) => void attrs.add(name),
    removeAttribute: (name: string) => void attrs.delete(name),
  };
}

/** The shape the session shell actually has: nested clipping boxes, with the
 *  sidebar / header / composer / panel hanging off them as siblings. */
function shell() {
  const body = node('body');
  const app = node('app', body);
  const layout = node('layout', app);
  const chat = node('chat', layout);
  const scroll = node('scroll', chat);
  const offChain = {
    sidebar: node('sidebar', app),
    header: node('header', layout),
    composer: node('composer', chat),
    panel: node('panel', layout),
  };
  return { body, app, layout, chat, scroll, offChain };
}

describe('markPrintChain', () => {
  test('marks the transcript as the root and every ancestor as passthrough', () => {
    const s = shell();
    markPrintChain(s.scroll, s.body);

    expect(s.scroll.attrs.has(PRINT_ROOT_ATTR)).toBe(true);
    for (const box of [s.chat, s.layout, s.app]) {
      expect(box.attrs.has(PRINT_PASSTHROUGH_ATTR)).toBe(true);
    }
  });

  test('stops at the boundary, so body keeps its own box', () => {
    const s = shell();
    markPrintChain(s.scroll, s.body);
    expect(s.body.attrs.size).toBe(0);
  });

  test('leaves off-chain siblings unmarked — the CSS rule hides exactly those', () => {
    const s = shell();
    markPrintChain(s.scroll, s.body);
    // Sidebar, header, composer and panel are the chrome that must not print.
    // None is on the chain, so none is marked, so the
    // `> *:not([data-print-passthrough]):not([data-print-root])` rule catches
    // all four without print.css ever naming one of them.
    for (const chrome of Object.values(s.offChain)) {
      expect(chrome.attrs.size).toBe(0);
    }
  });

  test('returns the marked nodes in chain order for exact cleanup', () => {
    const s = shell();
    const marked = markPrintChain(s.scroll, s.body);
    expect(marked.map((n) => n.id)).toEqual(['scroll', 'chat', 'layout', 'app']);
  });

  test('walks to the top when no boundary is given', () => {
    const s = shell();
    const marked = markPrintChain(s.scroll);
    expect(marked.map((n) => n.id)).toEqual(['scroll', 'chat', 'layout', 'app', 'body']);
  });

  test('a null root marks nothing', () => {
    expect(markPrintChain(null)).toEqual([]);
    expect(markPrintChain(undefined)).toEqual([]);
  });
});

describe('clearPrintChain', () => {
  test('removes every attribute it set', () => {
    const s = shell();
    const marked = markPrintChain(s.scroll, s.body);
    clearPrintChain(marked);

    for (const box of [s.scroll, s.chat, s.layout, s.app]) {
      expect(box.attrs.size).toBe(0);
    }
  });

  test('is idempotent', () => {
    const s = shell();
    const marked = markPrintChain(s.scroll, s.body);
    clearPrintChain(marked);
    expect(() => clearPrintChain(marked)).not.toThrow();
    expect(s.app.attrs.size).toBe(0);
  });

  test('clears a node that is no longer attached', () => {
    // The print dialog stays open as long as the user leaves it open, and the
    // session keeps streaming behind it. Cleanup must still strip the marks
    // from whatever it was handed, or the live app is left rendering as
    // `display: contents`.
    const s = shell();
    const marked = markPrintChain(s.scroll, s.body);
    (s.layout as { parentElement: FakeNode | null }).parentElement = null;
    clearPrintChain(marked);
    expect(s.layout.attrs.size).toBe(0);
  });
});
