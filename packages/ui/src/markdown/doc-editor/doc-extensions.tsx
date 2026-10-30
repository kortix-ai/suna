'use client';

/**
 * The one Kortix document editor's schema: what a Markdown doc can hold when
 * a person edits it in place. Doc artifacts and an agent's instructions use
 * the same set, so a doc reads and edits the same everywhere. The look is
 * `ARTIFACT_DOC_CSS` (`.kx-doc`); Markdown goes in and out through
 * `markdown.ts`.
 */

import { Code } from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Node, mergeAttributes, type Extensions } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { CheckIcon, PencilSimpleIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { SessionDotMatrix } from '../../primitives/dot-matrix/session-dot-matrix';
import { MermaidRenderer } from '../../primitives/mermaid-renderer';
import { TextShimmer } from '../../primitives/text-shimmer';
import { CopyButton } from '../copy-button';
import { LinkEmbed } from './doc-embed';

/**
 * `uploading`: a pasted or dropped file shown from a local URL while it
 * uploads (`data-uploading`). Never saved: `htmlToMarkdown` drops it.
 */
const uploadingAttribute = {
  uploading: {
    default: false,
    parseHTML: (el: HTMLElement) => el.hasAttribute('data-uploading'),
    renderHTML: (attrs: Record<string, unknown>) => (attrs.uploading ? { 'data-uploading': '' } : {}),
  },
};

/** An image or video in the editor, with an "Uploading…" chip while its file uploads. */
function MediaView({ node }: ReactNodeViewProps) {
  const t = useTranslations('artifacts');
  const { src, alt, title, uploading } = node.attrs as { src: string; alt?: string; title?: string; uploading: boolean };
  return (
    <NodeViewWrapper className="kx-media" data-uploading={uploading || undefined} data-drag-handle="">
      {node.type.name === 'video' ? (
        <video src={src} controls preload="metadata" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a doc's own media, any origin
        <img src={src} alt={alt ?? ''} title={title} />
      )}
      {uploading ? (
        <span
          contentEditable={false}
          className="bg-popover text-foreground absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm"
        >
          {/* The session's working loader, as the image tool shows while it generates. */}
          <SessionDotMatrix sessionId={src} size={14} className="shrink-0" />
          <TextShimmer duration={1} spread={2} className="text-xs">
            {t('uploading')}
          </TextShimmer>
        </span>
      ) : null}
    </NodeViewWrapper>
  );
}

/** An image in a doc (`![alt](src)` in the file). */
export const DocImage = Image.extend({
  draggable: true,
  addAttributes() {
    return { ...this.parent?.(), ...uploadingAttribute };
  },
  addNodeView() {
    return ReactNodeViewRenderer(MediaView);
  },
});

/** A video in a doc: `<video src controls>`, kept as HTML in the Markdown file. */
export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: null }, ...uploadingAttribute };
  },
  addNodeView() {
    return ReactNodeViewRenderer(MediaView);
  },
  parseHTML() {
    return [{ tag: 'video[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, { controls: 'true', preload: 'metadata' })];
  },
});

/** The code-fence language id of a block that names none: a Markdown token, not UI copy. */
const PLAIN_LANGUAGE = 'text';

function CodeBlockView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const t = useTranslations('artifacts');
  const [editing, setEditing] = useState(false);
  const source = node.textContent.trim();
  const language = (node.attrs.language as string | null) ?? '';
  const diagram = language === 'mermaid' && source;
  // A diagram shows as a picture; its source opens only for someone editing it.
  const showSource = !diagram || editing;
  return (
    <NodeViewWrapper as="div">
      {/* The UnifiedMarkdown code figure: a language caption with copy, then the code. */}
      <figure className="kx-code" hidden={!showSource}>
        <figcaption contentEditable={false}>
          {editor.isEditable ? (
            <input
              aria-label={t('codeLanguage')}
              placeholder={PLAIN_LANGUAGE}
              value={language}
              onChange={(e) => updateAttributes({ language: e.target.value.trim().toLowerCase() || null })}
            />
          ) : (
            <span>{language || PLAIN_LANGUAGE}</span>
          )}
          {source ? <CopyButton code={node.textContent} /> : null}
        </figcaption>
        <pre>
          <NodeViewContent<'code'> as="code" />
        </pre>
      </figure>
      {diagram ? (
        <div contentEditable={false} className="kx-diagram">
          <MermaidRenderer
            chart={source}
            enableFullscreen={false}
            actions={
              editor.isEditable ? (
                <Hint label={editing ? t('diagramDone') : t('diagramEdit')} side="top">
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label={editing ? t('diagramDone') : t('diagramEdit')}
                    aria-pressed={editing}
                    onClick={() => setEditing((v) => !v)}
                  >
                    {editing ? <CheckIcon className="size-3.5" /> : <PencilSimpleIcon className="size-3.5" />}
                  </Button>
                </Hint>
              ) : null
            }
          />
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

/**
 * Code blocks; a ```mermaid block also shows its diagram under the source.
 * The editor ignores events in the caption and the diagram: they belong to the
 * language field, Copy and Edit. A doc's diagram has no fullscreen view.
 */
export const DocCodeBlock = CodeBlock.extend({
  addNodeView() {
    // The element a DOM node or event target is, or sits in (a text node's parent).
    const elementOf = (target: unknown): Element | null =>
      target instanceof Element ? target : ((target as { parentElement?: Element | null } | null)?.parentElement ?? null);
    const controls = (target: unknown) => !!elementOf(target)?.closest('.kx-diagram, .kx-code > figcaption');
    return ReactNodeViewRenderer(CodeBlockView, {
      stopEvent: ({ event }) => controls(event.target),
    });
  },
});

/**
 * A line break in the Markdown source inside a paragraph. It reads as a space
 * and saves as the newline it was (`markdown.ts`), so a hard-wrapped file
 * keeps its lines. Backspace over it joins the words, like a space.
 */
export const SoftBreak = Node.create({
  name: 'softBreak',
  group: 'inline',
  inline: true,
  selectable: false,
  parseHTML() {
    return [{ tag: 'span[data-soft-break]' }];
  },
  renderHTML() {
    return ['span', { 'data-soft-break': '' }, ' '];
  },
  renderText() {
    return ' ';
  },
});

/**
 * Inline code that may sit inside bold or a link: StarterKit's code mark
 * excludes every other mark, which would drop the bold from
 * "**`view` before a task**" on the first save.
 */
const DocCode = Code.extend({ excludes: '' });

/** The document editor's extensions. `placeholder` names the empty line. */
export function docExtensions({
  editable,
  placeholder,
}: {
  editable: boolean;
  placeholder: (node: { type: { name: string } }) => string;
}): Extensions {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      link: { openOnClick: !editable, autolink: true, defaultProtocol: 'https' },
    }),
    DocCode,
    DocCodeBlock,
    SoftBreak,
    TableKit.configure({ table: { resizable: false } }),
    DocImage,
    Video,
    TaskList,
    TaskItem.configure({ nested: true }),
    LinkEmbed,
    Placeholder.configure({ placeholder: ({ node }) => placeholder(node) }),
  ];
}
