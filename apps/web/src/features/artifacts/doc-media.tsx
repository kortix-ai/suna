'use client';

import { MermaidRenderer } from '@kortix/ui/mermaid-renderer';
import CodeBlock from '@tiptap/extension-code-block';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';

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

function CodeBlockView({ node }: ReactNodeViewProps) {
  const source = node.textContent.trim();
  return (
    <NodeViewWrapper as="div">
      <pre>
        <NodeViewContent<'code'> as="code" />
      </pre>
      {node.attrs.language === 'mermaid' && source ? (
        <div contentEditable={false} className="kx-diagram">
          <MermaidRenderer chart={source} enableFullscreen={false} />
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
