'use client';

/**
 * The editor half of live co-editing (KRTX-3670, WP4): the tiptap pieces the
 * orchestration (`doc-coedit.ts`) does not know about.
 *
 * - `liveExtensions`: the doc schema bound to a `Y.Doc` (tiptap
 *   Collaboration, fragment `COEDIT_FIELD`). Its undo is the Yjs undo manager:
 *   it takes back this person's edits only, never a pulled one, and never the
 *   outside-edit merge (`addToHistory: false`).
 * - Media: the shared doc holds a file's own relative paths (`media/x.png`).
 *   The editor shows them against this tab's signed page URL; a signed URL in
 *   the shared doc would expire in 12 h and land in the file.
 * - `seedUpdate`: the first state of a doc, built from the file's Markdown
 *   through the editor's own load path.
 * - Untrusted attributes: any writer can put any JSON value on a node of the
 *   shared doc. The doc schema normalizes every change before the view renders
 *   it (`SafeAttributes`, doc-attrs.ts), node views read attributes through
 *   typed helpers, and a node view that still fails shows a placeholder for
 *   that node only (`safeNodeView`).
 */

import { createDocument, getSchema, type Editor, type Extensions } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { prosemirrorToYDoc, ySyncPluginKey } from '@tiptap/y-tiptap';
import { SessionDotMatrix } from '@kortix/ui/dot-matrix/session-dot-matrix';
import {
  DocImage,
  Video,
  attrBoolean,
  attrString,
  attrStringOrNull,
  safeNodeView,
} from '@kortix/ui/markdown/doc-editor/doc-extensions';
import { htmlToMarkdown, markdownToHtml, type DocRoundTrip } from '@kortix/ui/markdown/doc-editor/markdown';
import { TextShimmer } from '@kortix/ui/text-shimmer';
import { UsersThreeIcon } from '@phosphor-icons/react';
import * as Y from 'yjs';

import { COEDIT_FIELD, reportUnrenderable, type CoeditEditor, type CoeditFallback } from './doc-coedit';
import { unionMerge } from './doc-coedit-merge';
import { applyOutsideEdit } from './doc-outside-edit';

import { useTranslations } from '@/i18n/use-translations';

/** Images and videos that show a relative path against `resolve` (the doc's page URL). */
function liveMedia(resolve: (src: string) => string) {
  /** The doc editor's media view (doc-extensions.tsx), with the path resolved for display only. */
  function LiveMediaView({ node }: ReactNodeViewProps) {
    const t = useTranslations('artifacts');
    // Typed reads: a writer can set any JSON value on a node of the shared doc.
    const src = attrString(node.attrs.src);
    const alt = attrString(node.attrs.alt);
    const title = attrStringOrNull(node.attrs.title) ?? undefined;
    const uploading = attrBoolean(node.attrs.uploading);
    const shown = src ? resolve(src) : undefined;
    return (
      <NodeViewWrapper className="kx-media" data-uploading={uploading || undefined} data-drag-handle="">
        {node.type.name === 'video' ? (
          <video src={shown} controls preload="metadata" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a doc's own media, any origin
          <img src={shown} alt={alt} title={title} />
        )}
        {uploading ? (
          <span
            contentEditable={false}
            className="bg-popover text-foreground absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm"
          >
            <SessionDotMatrix sessionId={src} size={14} className="shrink-0" />
            <TextShimmer duration={1} spread={2} className="text-xs">
              {t('uploading')}
            </TextShimmer>
          </span>
        ) : null}
      </NodeViewWrapper>
    );
  }
  // One node that cannot render shows a placeholder; the pane stays.
  const View = safeNodeView(LiveMediaView);
  return {
    image: DocImage.extend({
      addNodeView() {
        return ReactNodeViewRenderer(View);
      },
    }),
    video: Video.extend({
      addNodeView() {
        return ReactNodeViewRenderer(View);
      },
    }),
  };
}

/**
 * The doc editor's extensions (`docExtensions`) bound to `doc`: Collaboration
 * on fragment `COEDIT_FIELD`, StarterKit's own undo off (Collaboration brings
 * the Yjs one), and media shown through `resolveSrc`.
 */
export function liveExtensions(
  base: Extensions,
  options: { doc: Y.Doc; resolveSrc: (src: string) => string },
): Extensions {
  const media = liveMedia(options.resolveSrc);
  return [
    ...base.map((extension) =>
      extension.name === 'starterKit'
        ? extension.configure({ undoRedo: false } as never)
        : extension.name === 'image'
          ? media.image
          : extension.name === 'video'
            ? media.video
            : extension,
    ),
    GuardedCollaboration.configure({ document: options.doc, field: COEDIT_FIELD }),
  ];
}

/**
 * Collaboration whose first render never throws out of the editor: on a doc
 * y-tiptap cannot render (a root node that is not an element), the binding
 * is undone, the editor stays empty and unbound, and the doc's session falls
 * back to autosave (`reportUnrenderable`). The session refuses to mount on
 * such a doc first (`bindable`); this is the last guard.
 */
const GuardedCollaboration = Collaboration.extend({
  addProseMirrorPlugins() {
    const plugins = this.parent?.() ?? [];
    const document = this.options.document as Y.Doc;
    for (const plugin of plugins) {
      const view = plugin.spec.view;
      if (plugin.spec.key !== ySyncPluginKey || !view) continue;
      plugin.spec.view = (editorView) => {
        try {
          return view(editorView);
        } catch {
          // initView registered the binding's observers before the render threw.
          (ySyncPluginKey.getState(editorView.state) as { binding?: { destroy(): void } } | undefined)?.binding?.destroy();
          reportUnrenderable(document);
          return {};
        }
      };
    }
    return plugins;
  },
});

/**
 * A doc's first Yjs state: `markdown` through the editor's load path
 * (`markdownToHtml`, then the schema's parser) into a scratch `Y.Doc`.
 * Media keep their relative paths.
 */
export function seedUpdate(markdown: string, extensions: Extensions): Uint8Array {
  const node = createDocument(markdownToHtml(markdown), getSchema(extensions));
  return Y.encodeStateAsUpdate(prosemirrorToYDoc(node, COEDIT_FIELD));
}

type SavedView = { from: number; to: number; before: string; focused: boolean };
/** How much text before the caret finds its place again in the rebuilt doc. */
const ANCHOR_CHARS = 32;

/** The leader's view of a live editor: its Markdown, and the outside-edit merge through the same load path. */
export function liveBridge(editor: Editor): CoeditEditor {
  const markdown = () => {
    if (editor.isDestroyed) throw new Error('The editor is destroyed');
    return htmlToMarkdown(editor.getHTML());
  };
  return {
    markdown,
    merge: (base, theirs) => applyOutsideEdit(editor, base, theirs, { toHtml: markdownToHtml }),
    // After a reset: the union of the rebuilt doc and the person's text, landed as one change from what
    // the editor shows now, so nothing clashes (doc-coedit-merge.ts).
    recover: (base, mine) => {
      const current = markdown();
      return applyOutsideEdit(editor, current, unionMerge(base, current, mine), { toHtml: markdownToHtml });
    },
    // The old editor of a reset: its caret, the text before it in its block, focus; and no more input
    // (its doc is gone).
    saveView: () => {
      if (editor.isDestroyed) return null;
      const { from, to, $from } = editor.state.selection;
      const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - ANCHOR_CHARS), $from.parentOffset);
      const view: SavedView = { from, to, before, focused: editor.isFocused };
      editor.setEditable(false);
      return view;
    },
    // The new editor of a reset: the caret after the same text, nearest its old place (else the old
    // position, clamped). Called on attach, and again once the person's text is back.
    restoreView: (saved) => {
      const view = saved as SavedView | null;
      if (!view || editor.isDestroyed) return;
      const { doc } = editor.state;
      let at = -1;
      if (view.before) {
        doc.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          const text = node.textContent;
          for (let i = text.indexOf(view.before); i >= 0; i = text.indexOf(view.before, i + 1)) {
            const candidate = pos + 1 + i + view.before.length;
            if (at < 0 || Math.abs(candidate - view.from) < Math.abs(at - view.from)) at = candidate;
          }
          return false;
        });
      }
      const size = doc.content.size;
      const from = Math.min(at >= 0 ? at : view.from, size);
      const to = Math.min(from + (view.to - view.from), size);
      try {
        editor.commands.setTextSelection({ from, to });
        if (view.focused) editor.commands.focus(undefined, { scrollIntoView: false });
      } catch {
        // A position the rebuilt doc cannot hold: the caret stays where the editor put it.
      }
    },
  };
}

/** Why co-editing is off for this doc, or why it stopped. */
export type CoeditNoteReason =
  | 'off-large'
  | 'off-line-endings'
  | 'off-shape'
  | 'stopped-large'
  | 'stopped-history'
  | 'stopped-failed';

export function guardNote(guard: DocRoundTrip): CoeditNoteReason {
  return guard.reason === 'too-large'
    ? 'off-large'
    : guard.reason === 'line-endings'
      ? 'off-line-endings'
      : 'off-shape';
}

/** The note of a fallback; none for a read-only viewer that waits for a seed. */
export const fallbackNote = (reason: CoeditFallback): CoeditNoteReason | undefined =>
  reason === 'too-large'
    ? 'stopped-large'
    : reason === 'history-too-large'
      ? 'stopped-history'
      : reason === 'unseeded'
        ? undefined
        : 'stopped-failed';

const NOTE_KEY = {
  'off-large': 'coedit.offLarge',
  'off-line-endings': 'coedit.offLineEndings',
  'off-shape': 'coedit.offShape',
  'stopped-large': 'coedit.stoppedLarge',
  'stopped-history': 'coedit.stoppedHistory',
  'stopped-failed': 'coedit.stoppedFailed',
} as const;

/** One quiet line above the doc: this editor saves alone, and why. */
export function CoeditNote({ reason }: { reason: CoeditNoteReason }) {
  const t = useTranslations('artifacts');
  return (
    // A div, not a p: the doc stylesheet spaces every p in `.kx-doc` as body text.
    <div
      role="status"
      data-coedit-note={reason}
      className="text-muted-foreground mb-6 flex items-start gap-1.5 text-xs text-pretty"
    >
      <UsersThreeIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{t(NOTE_KEY[reason])}</span>
    </div>
  );
}
