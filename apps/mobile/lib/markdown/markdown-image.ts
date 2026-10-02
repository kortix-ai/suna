/**
 * Markdown images. A remote image loads only where the project's agent wrote
 * the text (`components/markdown/markdown-image.tsx`); elsewhere a remote URL
 * could leak data on render, so the renderer shows a placeholder. This file
 * decides the placeholder's label and link, and groups image-only blocks into
 * galleries.
 */
export interface MarkdownImagePlaceholder {
  /** Alt text, else the source host, else "Image". */
  label: string;
  /** The trimmed source when it is an http(s) URL; null for data:, relative, or other schemes. */
  href: string | null;
}

const HTTP_URL = /^https?:\/\/([^/?#\s]*)/i;

export function describeMarkdownImage(src: unknown, alt: unknown): MarkdownImagePlaceholder {
  const source = typeof src === 'string' ? src.trim() : '';
  const authority = HTTP_URL.exec(source)?.[1];
  const href = authority === undefined ? null : source;
  const host = authority ? authority.slice(authority.lastIndexOf('@') + 1).toLowerCase() : '';
  const altText = typeof alt === 'string' ? alt.replace(/\s+/g, ' ').trim() : '';

  return { label: altText || host || 'Image', href };
}

/** One `![alt](src "title")` image, as the gallery and the inline image read it. */
export interface MarkdownImageRef {
  src: string;
  alt: string;
}

/** `![alt](src)` or `![alt](src "title")`; alt has no `]`, src has no space or `)`. */
const IMAGE_TOKEN = /!\[([^\]\n]{0,500})\]\(\s*([^\s)]{1,2048})(?:\s+"[^"\n]{0,500}")?\s*\)/g;

/** The images of a block that holds nothing but images (and whitespace), else null. */
export function imageOnlyBlock(block: string): MarkdownImageRef[] | null {
  const images: MarkdownImageRef[] = [];
  let rest = '';
  let last = 0;
  for (const match of block.matchAll(IMAGE_TOKEN)) {
    rest += block.slice(last, match.index);
    last = (match.index ?? 0) + match[0].length;
    images.push({ src: match[2], alt: match[1].trim() });
  }
  rest += block.slice(last);
  return images.length > 0 && rest.trim() === '' ? images : null;
}

export type MarkdownBlockItem =
  | { kind: 'markdown'; index: number; text: string }
  /** `index`..`last`: the blocks it replaces. `index` is its stable key while text streams in. */
  | { kind: 'gallery'; index: number; last: number; images: MarkdownImageRef[] };

/**
 * Runs of consecutive image-only blocks holding two or more images become one
 * swipeable gallery; anything else, a single image included, stays markdown.
 */
export function groupImageBlocks(blocks: readonly string[]): MarkdownBlockItem[] {
  const items: MarkdownBlockItem[] = [];
  let i = 0;
  while (i < blocks.length) {
    let j = i;
    const images: MarkdownImageRef[] = [];
    while (j < blocks.length) {
      const found = imageOnlyBlock(blocks[j]);
      if (!found) break;
      images.push(...found);
      j += 1;
    }
    if (images.length >= 2) {
      items.push({ kind: 'gallery', index: i, last: j - 1, images });
      i = j;
      continue;
    }
    for (let k = i; k < Math.max(j, i + 1); k += 1) items.push({ kind: 'markdown', index: k, text: blocks[k] });
    i = Math.max(j, i + 1);
  }
  return items;
}
