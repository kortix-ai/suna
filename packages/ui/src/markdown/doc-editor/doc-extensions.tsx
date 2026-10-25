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
import { MermaidRenderer } from '../../primitives/mermaid-renderer';
import { CopyButton } from '../copy-button';

/** A video in a doc: `<video src controls>`, kept as HTML in the Markdown file. */
export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'video[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, { controls: 'true', preload: 'metadata' })];
  },
});

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
              placeholder="text"
              value={language}
              onChange={(e) => updateAttributes({ language: e.target.value.trim().toLowerCase() || null })}
            />
          ) : (
            <span>{language || 'text'}</span>
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
                    variant="outline"
                    size="icon-sm"
                    className="bg-background/90 backdrop-blur-sm"
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

/** Code blocks; a ```mermaid block also shows its diagram under the source. */
export const DocCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
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
    Image,
    Video,
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: ({ node }) => placeholder(node) }),
  ];
}
