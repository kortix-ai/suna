'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { isKatexClassName } from '@/components/markdown/katex-markdown';

/** The class a streamed word carries; `globals.css` fades it in once, on mount. */
export const STREAM_WORD_CLASS = 'kx-stream-word';

/** The slice of hast this plugin reads; `@types/hast` is not a dependency of the app. */
interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  tagName: string;
  properties?: { className?: unknown };
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };
interface HastParent {
  children: HastNode[];
}

/** Subtrees whose text is not prose: code renders its own string, math and SVG are layout. */
const OPAQUE_TAGS = new Set(['code', 'pre', 'svg', 'math', 'script', 'style']);

function wordSpan(value: string): HastElement {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: [STREAM_WORD_CLASS] },
    children: [{ type: 'text', value }],
  };
}

function wrapWords(node: HastParent) {
  const out: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      for (const part of (child as HastText).value.split(/(\s+)/)) {
        if (!part) continue;
        out.push(/\s/.test(part[0]) ? { type: 'text', value: part } : wordSpan(part));
      }
      continue;
    }
    if (child.type === 'element') {
      const el = child as HastElement;
      const className = el.properties?.className as string | string[] | undefined;
      if (!OPAQUE_TAGS.has(el.tagName) && !isKatexClassName(className)) wrapWords(el);
    }
    out.push(child);
  }
  node.children = out;
}

/**
 * Rehype plugin for a message that is still streaming: every prose word
 * becomes its own `<span class="kx-stream-word">`.
 *
 * React keeps the DOM node of a word that was already on screen, so only the
 * words a render adds mount, and only they run the fade. That turns the step
 * between two paced renders into a soft fill instead of a pop. Only opacity
 * animates: no layout, no glyph repaint. Once the stream ends the plugin is
 * dropped and the message renders as plain text, the same as from history.
 */
export function rehypeStreamWords() {
  return (tree: HastParent) => wrapWords(tree);
}

/**
 * The window the words of one render are spread across.
 *
 * The pacer renders about every 32 ms (`STREAM_COMMIT_MS`), and one render
 * at a fast model's speed adds ~3 words. Fading those in on the same frame
 * reads as a lump every 32 ms. Spreading their start times across the gap
 * until the next render makes each word arrive on its own, so the fill is
 * continuous at the display's frame rate while React renders at half of it.
 */
export const STREAM_STAGGER_WINDOW_MS = 40;

/** Words mounted in the current render, in document order. */
let mounting: HTMLSpanElement[] = [];

function staggerMounting() {
  const step = STREAM_STAGGER_WINDOW_MS / mounting.length;
  for (let i = 1; i < mounting.length; i++) {
    mounting[i].style.animationDelay = `${(i * step).toFixed(1)}ms`;
  }
  mounting = [];
}

/**
 * One streamed word. Its layout effect runs once, on mount, with every other
 * word the same render mounted; the microtask then gives each its delay
 * before the browser paints. A word already on screen keeps its node, so it
 * never fades again.
 */
export function StreamWord({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    if (mounting.length === 0) queueMicrotask(staggerMounting);
    mounting.push(ref.current);
  }, []);
  return (
    <span ref={ref} className={STREAM_WORD_CLASS}>
      {children}
    </span>
  );
}
