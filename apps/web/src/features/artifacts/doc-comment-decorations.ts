import type { ArtifactCommentThread } from '@kortix/sdk';
import { reanchorArtifactText } from '@kortix/shared/artifact-comments';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { docMarkdownPositions, docRangesForSource } from './doc-comment-positions';

export const docCommentPluginKey = new PluginKey<DecorationSet>('artifactDocComments');
export interface DocCommentHighlights {
  markdown: string;
  comments: readonly ArtifactCommentThread[];
  focusedThreadId?: string | null;
  version?: string | null;
  entryVersion?: string | null;
  label: string;
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
        const marks: Decoration[] = [];
        const boundaries = new Map<number, Map<string, number>>();
        for (const thread of input.comments) {
          if (
            thread.anchor.type !== 'text' ||
            (input.version &&
              thread.anchor.version !== input.version &&
              thread.anchor.version !== input.entryVersion)
          )
            continue;
          const position = reanchorArtifactText(input.markdown, thread.anchor);
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
        for (let index = 0; index < points.length - 1; index++) {
          const from = points[index]!;
          for (const [id, delta] of boundaries.get(from)!) {
            const count = (active.get(id) ?? 0) + delta;
            if (count > 0) active.set(id, count);
            else active.delete(id);
          }
          if (!active.size) continue;
          const ids = [...active.keys()].sort();
          const focused = focusedThreadId !== null && active.has(focusedThreadId);
          marks.push(
            Decoration.inline(from, points[index + 1]!, {
              'data-artifact-threads': ids.join(' '),
              'data-artifact-thread': focused ? focusedThreadId! : ids[0]!,
              role: 'button',
              tabindex: '0',
              'aria-label': ids.length === 1 ? input.label : `${input.label} (${ids.length})`,
              class: focused
                ? 'cursor-pointer rounded-sm bg-kortix-blue/15 underline decoration-kortix-blue focus-visible:outline-ring'
                : 'cursor-pointer rounded-sm bg-hover underline decoration-border hover:bg-active focus-visible:outline-ring',
            }),
          );
        }
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
