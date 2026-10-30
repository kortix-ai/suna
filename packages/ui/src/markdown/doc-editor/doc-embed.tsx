'use client';

import type { LinkPreview } from '@kortix/sdk';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { FaviconAvatar } from '../../primitives/favicon-avatar';
import { Hint } from '../../primitives/hint';
import { faviconUrlForUrl } from '../../lib/favicon';
import { successToast } from '../../primitives/toast';
import { ArrowSquareOutIcon, LinkSimpleIcon, TextTIcon, TrashIcon } from '@phosphor-icons/react';
import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';

/**
 * A pasted link shown as a card: its title, its description and the address on
 * the left, the page's Open Graph image (when it has one) on the right. With
 * no image, the site's favicon sits before the address. The
 * card is stored in the Markdown file as one line of HTML
 * (`<div class="kx-embed">…</div>`), so the published page shows it without
 * fetching anything but that image; the doc stylesheet draws it.
 */
export type EmbedMeta = { href: string; title: string; summary: string; image: string };

const SUMMARY_MAX = 220;

/** A link that can be a card: any http(s) address. */
export function canEmbed(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href) && URL.canParse(href);
}

/** `fix-the-thing` → `Fix the thing`. */
function fromSlug(slug: string): string {
  const words = decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A Linear page's id and name from its URL: its pages need a login, so they tell nothing more. */
function linearTitle(url: URL): string | null {
  if (url.hostname !== 'linear.app') return null;
  const [, section, id, slug] = url.pathname.split('/').filter(Boolean);
  if (section === 'issue' && id) return [id.toUpperCase(), slug ? fromSlug(slug) : ''].filter(Boolean).join(' ');
  // A project or document link ends in `<name>-<hash>`.
  return id ? fromSlug(id.replace(/-[0-9a-f]{8,}$/i, '')) : 'Linear';
}

/** One plain line from page text (Markdown or HTML removed), capped. */
export function plainSummary(text: string | null | undefined): string {
  if (!text) return '';
  const plain = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]/g, '')
    // Text a page escaped twice (GitHub's descriptions): shown as written, after tags are gone.
    .replace(/&(lt|gt|quot|#39|apos|amp);/g, (_m, name: string) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", amp: '&' })[name] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > SUMMARY_MAX ? `${plain.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : plain;
}

/** What the URL alone tells: the card when the page says nothing (a private page, Linear, a failed read). */
export function embedFromUrl(href: string): EmbedMeta | null {
  if (!canEmbed(href)) return null;
  const url = new URL(href);
  const title = linearTitle(url) ?? `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  return { href, title, summary: '', image: '' };
}

/**
 * The card for a link: the page's own title, description and image, read by
 * the API (`read`: `getLinkPreview` for the doc's project). GitHub's title
 * reads "… by author · Pull Request #12 · owner/repo". Linear is not read (its
 * pages need a login); a page that cannot be read is the card the URL gives.
 */
export async function fetchEmbed(href: string, read: (url: string) => Promise<LinkPreview>): Promise<EmbedMeta | null> {
  const base = embedFromUrl(href);
  if (!base || new URL(href).hostname === 'linear.app') return base;
  try {
    const page = await read(href);
    return { href, title: page.title ?? base.title, summary: plainSummary(page.description), image: page.image_url ?? '' };
  } catch {
    return base;
  }
}

const text = (el: HTMLElement, cls: string) => el.querySelector(`.${cls}`)?.textContent?.trim() ?? '';

/** The card's markup: the same in the editor and in the stored HTML. */
function CardBody({ href, title, summary, image, onClick }: EmbedMeta & { onClick?: (e: React.MouseEvent) => void }) {
  // An image that does not load (gone, blocked) leaves the card text only.
  const [broken, setBroken] = useState(false);
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
      <span className="kx-embed-text">
        <span className="kx-embed-title">{title}</span>
        {summary ? <span className="kx-embed-summary">{summary}</span> : null}
        <span className="kx-embed-url">
          {!image || broken ? <FaviconAvatar value={href} size="2xs" /> : null}
          <span className="kx-embed-href">{href}</span>
        </span>
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element -- a page's own Open Graph image, any origin */}
      {image && !broken ? <img className="kx-embed-image" src={image} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : null}
    </a>
  );
}

/**
 * The card in the editor, with its actions on hover, in one button group:
 * Open link, Convert to a plain link, Copy link, Delete. While editing, a click on the card selects
 * it; Open link opens the page.
 */
function LinkEmbedView({ node, editor, getPos, deleteNode }: ReactNodeViewProps) {
  const t = useTranslations('artifacts');
  const meta = node.attrs as EmbedMeta;
  const editable = editor.isEditable;
  const convert = () => {
    const at = getPos();
    if (typeof at !== 'number') return;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: at, to: at + node.nodeSize },
        { type: 'paragraph', content: [{ type: 'text', text: meta.href, marks: [{ type: 'link', attrs: { href: meta.href } }] }] },
      )
      .run();
  };
  const copy = async () => {
    await navigator.clipboard.writeText(meta.href);
    successToast(t('linkCopied'));
  };
  const action = (label: string, Icon: typeof TrashIcon, run: () => void) => (
    <Hint label={label} side="top">
      <Button variant="secondary" size="icon-sm" aria-label={label} onClick={run}>
        <Icon className="size-3.5" />
      </Button>
    </Hint>
  );
  return (
    <NodeViewWrapper className="kx-embed group/embed relative">
      <CardBody {...meta} onClick={editable ? (e) => e.preventDefault() : undefined} />
      <div
        contentEditable={false}
        data-embed-actions=""
        className="absolute top-2 right-2 opacity-0 transition-opacity group-focus-within/embed:opacity-100 group-hover/embed:opacity-100"
      >
        <ButtonGroup>
          {action(t('embedOpen'), ArrowSquareOutIcon, () => window.open(meta.href, '_blank', 'noopener,noreferrer'))}
          {editable ? action(t('embedConvert'), TextTIcon, convert) : null}
          {action(t('embedCopy'), LinkSimpleIcon, () => void copy())}
          {editable ? action(t('embedDelete'), TrashIcon, deleteNode) : null}
        </ButtonGroup>
      </div>
    </NodeViewWrapper>
  );
}

/** The card in a doc: an atom block, `div.kx-embed` in the HTML and in the Markdown file. */
export const LinkEmbed = Node.create({
  name: 'linkEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      href: { default: '', rendered: false, parseHTML: (el) => el.querySelector('a')?.getAttribute('href') ?? '' },
      title: { default: '', rendered: false, parseHTML: (el) => text(el, 'kx-embed-title') },
      summary: { default: '', rendered: false, parseHTML: (el) => text(el, 'kx-embed-summary') },
      image: { default: '', rendered: false, parseHTML: (el) => el.querySelector('img.kx-embed-image')?.getAttribute('src') ?? '' },
    };
  },
  parseHTML() {
    return [{ tag: 'div.kx-embed', priority: 60 }];
  },
  renderHTML({ node }) {
    const { href, title, summary, image } = node.attrs as EmbedMeta;
    const textParts: unknown[] = [['span', { class: 'kx-embed-title' }, title]];
    if (summary) textParts.push(['span', { class: 'kx-embed-summary' }, summary]);
    const favicon = image ? null : faviconUrlForUrl(href);
    textParts.push([
      'span',
      { class: 'kx-embed-url' },
      ...(favicon ? [['img', { class: 'kx-embed-favicon', src: favicon, alt: '', referrerpolicy: 'no-referrer' }]] : []),
      ['span', { class: 'kx-embed-href' }, href],
    ]);
    const body: unknown[] = [['span', { class: 'kx-embed-text' }, ...textParts]];
    if (image) body.push(['img', { class: 'kx-embed-image', src: image, alt: '', referrerpolicy: 'no-referrer' }]);
    return ['div', { class: 'kx-embed' }, ['a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...body]] as never;
  },
  addNodeView() {
    // The editor leaves the action buttons to themselves (see DocCodeBlock).
    return ReactNodeViewRenderer(LinkEmbedView, {
      stopEvent: ({ event }) => !!(event.target as Element | null)?.closest?.('[data-embed-actions]'),
    });
  },
});
