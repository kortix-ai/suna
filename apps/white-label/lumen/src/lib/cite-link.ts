// A Lumen citation link in Markdown: `[1](/cite?d=<docId>&a=p3.12&q=<url-encoded quote>)`.

export interface Cite {
  d: string;
  a: string;
  q: string;
}

export const CITE_SELECTOR = 'a[href*="/cite?"]';

/** The citation a link carries, or null when it is not a Lumen citation link. */
export function parseCite(href: string | null): Cite | null {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://lumen.invalid');
    if (u.pathname !== '/cite') return null;
    const d = u.searchParams.get('d') ?? '';
    const a = u.searchParams.get('a') ?? '';
    return d && a ? { d, a, q: u.searchParams.get('q') ?? '' } : null;
  } catch {
    return null;
  }
}

/** A finished answer block (`.kortix-markdown`, not streaming) that cites "[n]" with no citation link in it. */
export function hasUnlinkedCitations(root: ParentNode): boolean {
  return [...root.querySelectorAll<HTMLElement>('.kortix-markdown[data-streaming="false"]')].some(
    (el) => !el.querySelector(CITE_SELECTOR) && /\[\d{1,3}\]/.test(el.textContent ?? ''),
  );
}
