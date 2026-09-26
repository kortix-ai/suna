/**
 * What the markdown renderer lets a piece of content do, decided by who wrote
 * it and how it is shown. `UnifiedMarkdown` reads this and nothing else, so
 * every caller states both facts and no rendering rule lives at a call site.
 */

/**
 * Who wrote the text. Every caller names one; there is no default.
 *
 * - `trusted` — Kortix wrote it: bundled product and marketing copy.
 * - `agent` — the project's agent or a project member wrote it: messages,
 *   questions, `show` cards, project files, change-request descriptions.
 * - `untrusted` — a third party wrote it: scraped pages, tool and connector
 *   output, marketplace listings from a registry.
 */
export type MarkdownTrust = 'trusted' | 'agent' | 'untrusted';

/**
 * How the text is shown.
 *
 * - `message` — prose. Embedded HTML is parsed (through the sanitizer).
 * - `document` — a markdown file. Embedded HTML is not parsed: its tags are
 *   dropped and its text stays, so markup in a file never becomes live DOM.
 */
export type MarkdownVariant = 'message' | 'document';

/**
 * `load` fetches every image as it renders. `click-to-load` shows a button in
 * place of an image hosted outside this app and fetches it only on click, so
 * rendering third-party content never sends a request to a host that content
 * chose.
 */
export type MarkdownRemoteImages = 'load' | 'click-to-load';

export interface MarkdownPolicy {
  /** Parse embedded HTML into (sanitized) DOM. */
  rawHtml: boolean;
  remoteImages: MarkdownRemoteImages;
  /**
   * Turn an agent-minted setup link (`/secret-intake/<token>`,
   * `/connect/<token>`) into the in-app setup card. Off, it stays a plain link
   * to the same page.
   */
  setupLinks: boolean;
}

const WRITER_RULES: Record<MarkdownTrust, Omit<MarkdownPolicy, 'rawHtml'>> = {
  trusted: { remoteImages: 'load', setupLinks: false },
  agent: { remoteImages: 'load', setupLinks: true },
  untrusted: { remoteImages: 'click-to-load', setupLinks: false },
};

const TRUST_LEVELS = Object.keys(WRITER_RULES) as MarkdownTrust[];
const VARIANTS: MarkdownVariant[] = ['message', 'document'];

/**
 * One frozen object per (trust, variant). The renderer puts the policy in a
 * context value and picks module-level plugin arrays from it; a stable
 * identity keeps Streamdown from re-parsing every block on each render.
 */
const POLICIES = Object.fromEntries(
  TRUST_LEVELS.map((trust) => [
    trust,
    Object.fromEntries(
      VARIANTS.map((variant) => [
        variant,
        Object.freeze({ ...WRITER_RULES[trust], rawHtml: variant === 'message' }),
      ]),
    ),
  ]),
) as Record<MarkdownTrust, Record<MarkdownVariant, Readonly<MarkdownPolicy>>>;

export function markdownPolicy(
  trust: MarkdownTrust,
  variant: MarkdownVariant = 'message',
): Readonly<MarkdownPolicy> {
  return POLICIES[trust][variant];
}
