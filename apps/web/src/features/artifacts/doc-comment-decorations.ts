import type { ArtifactCommentThread } from '@kortix/sdk';
import { createArtifactReanchorBudgets, reanchorArtifactText } from '@kortix/shared/artifact-comments';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { threadAuthor, threadDeleted } from './artifact-discussion-logic';
import { docMarkdownPositions, docRangesForSource } from './doc-comment-positions';

export const docCommentPluginKey = new PluginKey<DecorationSet>('artifactDocComments');

/**
 * The passage of a comment thread: the status tint (`/15`) over a 1px yellow
 * underline. Hover, and the thread open in the panel, thicken the underline
 * to 3px. The brand allows a `/15` tint and the solid accent only, so the
 * stronger state is a heavier line, not a darker fill. Square corners and an
 * underline keep a passage continuous across segments and line wraps.
 */
const HIGHLIGHT =
  'cursor-pointer bg-kortix-yellow/15 text-inherit underline decoration-kortix-yellow underline-offset-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';
const HIGHLIGHT_IDLE = `${HIGHLIGHT} decoration-1 hover:decoration-3`;
const HIGHLIGHT_FOCUSED = `${HIGHLIGHT} decoration-3`;
export interface DocCommentHighlights {
  markdown: string;
  comments: readonly ArtifactCommentThread[];
  focusedThreadId?: string | null;
  version?: string | null;
  entryVersion?: string | null;
  label: string;
  /**
   * One tab stop per thread (default true). An editable doc passes false: the
   * editing host keeps focus and Enter types, so the panel's "Show passage"
   * button is the keyboard path there.
   */
  focusable?: boolean;
}

export function scrollDocCommentHighlight(
  root: HTMLElement,
  threadId: string | null | undefined,
  revision: number | undefined,
  handled: string,
): string {
  if (!threadId) return '';
  const signature = JSON.stringify([threadId, revision ?? 0]);
  if (signature === handled) return handled;
  const highlight = Array.from(root.querySelectorAll<HTMLElement>('[data-artifact-threads], [data-artifact-thread]')).find(
    (element) => (element.getAttribute('data-artifact-threads') ?? element.getAttribute('data-artifact-thread'))?.split(' ').includes(threadId),
  );
  if (!highlight) return handled;
  highlight.scrollIntoView({ block: 'center' });
  return signature;
}

export function createDocCommentPlugin(onFocus: (threadId: string) => void): Plugin<DecorationSet> {
  let focusedThreadId: string | null = null;
  const focus = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    const ids = element?.closest?.('[data-artifact-threads]')?.getAttribute('data-artifact-threads')?.split(' ');
    if (!ids?.length) return false;
    focusedThreadId = ids[(ids.indexOf(focusedThreadId ?? '') + 1) % ids.length]!;
    onFocus(focusedThreadId);
    return true;
  };
  return new Plugin({
    key: docCommentPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, decorations) {
        const input = transaction.getMeta(docCommentPluginKey) as DocCommentHighlights | undefined;
        if (!input) return decorations.map(transaction.mapping, transaction.doc);
        focusedThreadId = input.focusedThreadId ?? null;
        const map = docMarkdownPositions(input.markdown, transaction.doc);
        const boundaries = new Map<number, Map<string, number>>();
        // One re-anchoring budget per pass, split per thread author: crafted quotes cannot freeze the tab
        // or leave other people's highlights out.
        const budgetFor = createArtifactReanchorBudgets(input.comments.map(threadAuthor));
        for (const thread of input.comments) {
          // The rule of the HTML pins: an open thread, or the resolved one open in the panel.
          if (
            thread.anchor.type !== 'text' ||
            threadDeleted(thread) ||
            (thread.status !== 'open' && thread.thread_id !== focusedThreadId) ||
            (input.version &&
              thread.anchor.version !== input.version &&
              thread.anchor.version !== input.entryVersion)
          )
            continue;
          const position = reanchorArtifactText(input.markdown, thread.anchor, budgetFor(threadAuthor(thread)));
          if (position.start === null || position.end === null) continue;
          for (const range of docRangesForSource(map, position.start, position.end)) {
            for (const [at, delta] of [[range.from, 1], [range.to, -1]] as const) {
              const changes = boundaries.get(at) ?? new Map<string, number>();
              changes.set(thread.thread_id, (changes.get(thread.thread_id) ?? 0) + delta);
              boundaries.set(at, changes);
            }
          }
        }
        const points = [...boundaries.keys()].sort((a, b) => a - b);
        const active = new Map<string, number>();
        const segments: Array<{ from: number; to: number; ids: string[] }> = [];
        for (let index = 0; index < points.length - 1; index++) {
          const from = points[index]!;
          for (const [id, delta] of boundaries.get(from)!) {
            const count = (active.get(id) ?? 0) + delta;
            if (count > 0) active.set(id, count);
            else active.delete(id);
          }
          if (active.size) segments.push({ from, to: points[index + 1]!, ids: [...active.keys()].sort() });
        }
        // One tab stop per thread: the first segment of each thread.
        const stops = new Set<number>();
        const seen = new Set<string>();
        segments.forEach(({ ids }, index) => {
          for (const id of ids) {
            if (seen.has(id) || input.focusable === false) continue;
            seen.add(id);
            stops.add(index);
          }
        });
        const marks = segments.map(({ from, to, ids }, index) => {
          const focused = focusedThreadId !== null && ids.includes(focusedThreadId);
          // A <mark> keeps the passage in the accessibility tree; aria-details links the thread cards.
          return Decoration.inline(from, to, {
            nodeName: 'mark',
            'data-artifact-threads': ids.join(' '),
            'data-artifact-thread': focused ? focusedThreadId! : ids[0]!,
            'aria-details': ids.map((id) => `artifact-thread-${id}`).join(' '),
            'aria-description': ids.length === 1 ? input.label : `${input.label} (${ids.length})`,
            ...(stops.has(index) ? { tabindex: '0' } : {}),
            class: focused ? HIGHLIGHT_FOCUSED : HIGHLIGHT_IDLE,
          });
        });
        return DecorationSet.create(transaction.doc, marks);
      },
    },
    props: {
      decorations: (state) => docCommentPluginKey.getState(state) ?? DecorationSet.empty,
      handleDOMEvents: {
        click: (view, event) => {
          const selection = view.dom.ownerDocument.getSelection();
          if (selection && !selection.isCollapsed) return false;
          if (!focus(event.target)) return false;
          event.preventDefault();
          return true;
        },
        keydown: (_view, event) => {
          if ((event.key === 'Enter' || event.key === ' ') && focus(event.target)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
  });
}

export const DocCommentDecorations = Extension.create<{ onFocus: (threadId: string) => void }>({
  name: 'artifactDocComments',
  addOptions: () => ({ onFocus: () => {} }),
  addProseMirrorPlugins() {
    return [createDocCommentPlugin((id) => this.options.onFocus(id))];
  },
});
