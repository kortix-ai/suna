'use client';

import { Button } from '@kortix/ui/button';
import { CopyButton } from '@kortix/ui/markdown/copy-button';
import { Hint } from '@kortix/ui/hint';
import { SessionDotMatrix } from '@kortix/ui/dot-matrix/session-dot-matrix';
import { MermaidRenderer } from '@kortix/ui/mermaid-renderer';
import { TextShimmer } from '@kortix/ui/text-shimmer';
import { CheckIcon, PencilSimpleIcon } from '@phosphor-icons/react';
import CodeBlock from '@tiptap/extension-code-block';
import Image from '@tiptap/extension-image';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';

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

const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/** The path a pasted or dropped file gets in the doc's folder: `media/<time>-<name>`. */
export function mediaPath(file: File): string {
  const clean = file.name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'file';
  return `media/${Date.now().toString(36)}-${clean}`;
}

export function isMedia(file: File): 'image' | 'video' | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return null;
}

export function tooLarge(file: File): boolean {
  return file.size > MAX_MEDIA_BYTES;
}

export async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Relative media paths (`media/x.png`) as the editor shows them: absolute
 * against the doc's signed page URL. `restore` turns them back on save, so the
 * Markdown file keeps paths that work in Files and on every page.
 */
export function mediaUrls(baseUrl: string) {
  const toRelative = new Map<string, string>();
  return {
    absolute(path: string): string {
      if (ABSOLUTE.test(path)) return path;
      const url = new URL(path, baseUrl).toString();
      toRelative.set(url, path);
      return url;
    },
    resolveHtml(html: string): string {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('img[src], video[src]').forEach((el) => el.setAttribute('src', this.absolute(el.getAttribute('src')!)));
      return doc.body.innerHTML;
    },
    restore(html: string): string {
      let out = html;
      for (const [url, path] of toRelative) out = out.split(url).join(path);
      return out;
    },
  };
}
