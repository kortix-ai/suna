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

type MessageLike = { info: { id: string; role: string }; parts: ReadonlyArray<{ type: string; text?: string }> };

/**
 * The id of the last answer when it cites "[n]" with no citation link at all, else null.
 * Lumen cannot check such an answer, so the thread asks the agent once to rewrite it.
 */
export function unlinkedAnswerId(messages: readonly unknown[]): string | null {
  const last = [...(messages as MessageLike[])].reverse().find((m) => m?.info?.role === 'assistant' || m?.info?.role === 'user');
  if (!last || last.info.role !== 'assistant') return null;
  const text = last.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
  return /\[\d{1,3}\]/.test(text) && !text.includes('](/cite?') ? last.info.id : null;
}

/** The one follow-up the thread sends for an answer with bare "[n]" citations. */
export const CITATION_REPAIR_PROMPT =
  'Your last answer cites sources as bare [n] markers with no citation links, so Lumen cannot check them. Rewrite the same answer: run `lumen cite check` on each citation and paste its `link` after each claim, in the /cite form your instructions give. Do not add new findings.';
