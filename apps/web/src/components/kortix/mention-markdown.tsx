'use client';

/**
 * Markdown + @-mention highlighting.
 *
 * Renders the full markdown via UnifiedMarkdown (the repo's Streamdown-based
 * renderer — headings, lists, code fences, tables, links, the lot) and then
 * decorates recognised @mentions in the rendered DOM with primary / amber
 * styling. Self-mentions (@<your-handle>) use amber; teammate mentions use
 * primary.
 *
 * Why a DOM walk and not a remark plugin? Streamdown exposes component
 * overrides but not a rehype extension point in this project, and text
 * nodes inside rendered paragraphs / list items / blockquotes all need
 * decoration uniformly. A narrow walker (skipping <code> + <pre>) gets
 * the right coverage without touching the renderer internals.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { UnifiedMarkdown } from '@/components/markdown';
import type { ProjectAgent } from '@/hooks/kortix/use-kortix-tickets';

interface Props {
  content: string;
  agents: ProjectAgent[];
  userHandle: string;
  className?: string;
}

const DECORATED_MARK = 'data-mention-decorated';
const OTHER_CLS = 'font-semibold text-primary rounded-sm px-0.5 bg-primary/10';
const SELF_CLS = 'font-bold text-amber-400 rounded-sm px-0.5 bg-amber-500/15';

export function MentionMarkdown({ content, agents, userHandle, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const slugs = useMemo(() => {
    const s = new Set<string>();
    s.add(userHandle.toLowerCase());
    for (const a of agents) s.add(a.slug.toLowerCase());
    return s;
  }, [agents, userHandle]);

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const undos = decorate(root, slugs, userHandle.toLowerCase());
    // Revert every DOM mutation we made BEFORE React tries to unmount or
    // reconcile the subtree. Without this, React's internal child list
    // still points at the original text nodes we replaced, and it throws
    //   "Failed to execute 'removeChild' on 'Node': The node to be
    //    removed is not a child of this node"
    // on the next re-render / unmount.
    return () => {
      for (let i = undos.length - 1; i >= 0; i--) {
        try { undos[i](); } catch {}
      }
    };
  }, [content, slugs, userHandle]);

  return (
    <div
      ref={containerRef}
      className={cn('prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1', className)}
    >
      <UnifiedMarkdown content={content} />
    </div>
  );
}

function decorate(root: HTMLElement, slugs: Set<string>, selfHandle: string): Array<() => void> {
  // Walk text nodes, skipping anything inside <code>, <pre>, or already-decorated
  // spans. We collect candidates first, then mutate — mutating during the walk
  // invalidates the iterator.
  const skipEl = (el: Element | null): boolean =>
    !!el && (
      el.tagName === 'CODE' ||
      el.tagName === 'PRE' ||
      el.hasAttribute(DECORATED_MARK) ||
      !!el.closest(`[${DECORATED_MARK}]`) ||
      !!el.closest('code, pre')
    );

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const text = node.nodeValue;
      if (!text || text.indexOf('@') < 0) return NodeFilter.FILTER_REJECT;
      if (skipEl(node.parentElement)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  const undos: Array<() => void> = [];
  const re = /(^|\s)@([a-z0-9_.-]+)/gi;
  for (const textNode of targets) {
    const text = textNode.nodeValue ?? '';
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lastIdx = 0;
    let frag: DocumentFragment | null = null;

    while ((match = re.exec(text))) {
      const atIdx = match.index + match[1].length;
      const slug = match[2].toLowerCase();
      if (!slugs.has(slug)) continue;
      if (!frag) frag = document.createDocumentFragment();
      if (atIdx > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, atIdx)));
      }
      const span = document.createElement('span');
      span.setAttribute(DECORATED_MARK, '');
      span.className = slug === selfHandle ? SELF_CLS : OTHER_CLS;
      span.textContent = '@' + match[2];
      frag.appendChild(span);
      lastIdx = atIdx + 1 + match[2].length;
    }

    if (frag) {
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      const parent = textNode.parentNode;
      const nextSibling = textNode.nextSibling;
      if (!parent) continue;
      // Snapshot the fragment's children BEFORE replaceChild — the call
      // empties the fragment, so we can't read from it afterwards.
      const injected = Array.from(frag.childNodes);
      parent.replaceChild(frag, textNode);
      // Undo: remove our injected nodes and re-insert the original text
      // node in its original position. React's internal child list still
      // expects `textNode` to be there; this restoration keeps that list
      // valid so reconciliation / unmount won't throw removeChild errors.
      undos.push(() => {
        for (const child of injected) {
          if (child.parentNode === parent) parent.removeChild(child);
        }
        if (nextSibling && nextSibling.parentNode === parent) {
          parent.insertBefore(textNode, nextSibling);
        } else {
          parent.appendChild(textNode);
        }
      });
    }
  }
  return undos;
}
