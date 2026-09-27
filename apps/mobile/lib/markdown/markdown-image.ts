/**
 * Markdown images in agent output are never fetched automatically: a remote
 * URL can exfiltrate data on render, and a large image can exhaust memory on
 * decode. The renderer shows a placeholder instead. This decides its label and
 * whether tapping it may open the source in the browser.
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
