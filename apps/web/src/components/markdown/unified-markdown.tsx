'use client';

import { useTranslations } from '@/i18n/use-translations';

import { wrapChildrenWithPaths } from '@/components/common/clickable-path';
import { MarkdownCode } from '@/components/markdown/code';
import { InsideLinkContext } from '@/components/markdown/code/inside-link-context';
import {
  isKatexClassName,
  katexRehypePlugins,
  katexRehypePluginsNoRaw,
  katexRemarkPlugins,
  normalizeClassName,
} from '@/components/markdown/katex-markdown';
import { MarkdownOrderedList } from '@/components/markdown/ordered-list';
import {
  hasLinkReferenceDefinition,
  isInternalUrl,
  isStreamingLinkPlaceholder,
  prepareMarkdownSource,
  remoteImageHost,
  shouldUseNextLink,
} from '@/components/markdown/unified-markdown-utils';
import { SetupLinkButton } from '@/components/setup-links/setup-link-button';
import { parsePendingSetupLinkHref, parseSetupLinkHref } from '@/components/setup-links/util';
import { Button } from '@/components/ui/button';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { cn } from '@/lib/utils';
import { ImageIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import React, { useCallback, useContext, useMemo, useState } from 'react';
import { parseMarkdownIntoBlocks, Streamdown } from 'streamdown';

const LINK_CLASS = cn(
  'font-medium text-kortix-blue',
  'underline decoration-kortix-blue/40 decoration-[1px] underline-offset-[3px]',
  'transition-colors hover:decoration-kortix-blue',
  '[overflow-wrap:anywhere]',
);

function handleHashClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (!href.startsWith('#')) return;
  e.preventDefault();
  document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * What a renderer needs from the message it sits in. It arrives by context,
 * not by closure, so `MARKDOWN_COMPONENTS` can be module-level.
 */
interface MarkdownRenderContextValue {
  isStreaming: boolean;
  proxy: (url: string | undefined) => string | undefined;
  remoteImages: MarkdownRemoteImages;
}

/**
 * `load` fetches every image as it renders. `click-to-load` shows a button in
 * place of an image hosted outside this app and fetches it only on click, so
 * rendering third-party content never sends a request to a host that content
 * chose.
 */
export type MarkdownRemoteImages = 'load' | 'click-to-load';

const MarkdownRenderContext = React.createContext<MarkdownRenderContextValue>({
  isStreaming: false,
  proxy: (url) => url,
  remoteImages: 'load',
});

/**
 * Every renderer the markdown uses, defined once for the module.
 *
 * The identities never change, and that is load-bearing. Each function here is
 * an element TYPE to React. This map used to be rebuilt whenever `isStreaming`
 * or the sandbox proxy changed, which changed every type in the message at
 * once, so React remounted all of it: at the end of every turn an open
 * setup-link modal closed and its connect poll stopped, and code blocks and
 * diagrams rendered again. Values that change arrive through
 * `MarkdownRenderContext` instead. The stable map also lets Streamdown's
 * per-block memo skip every block the new text did not touch.
 */
const MARKDOWN_COMPONENTS = {
  // Headings — graduated hierarchy bounded by text-base (h6) → text-xl (h1).
  // Only 3 named sizes live in that range, so deeper levels step down via
  // weight, colour, and top-margin instead.
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-foreground mt-10 mb-4 text-xl font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-foreground mt-8 mb-3 text-xl font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-foreground mt-6 mb-2 text-lg font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="text-foreground mt-6 mb-2 text-lg font-semibold first:mt-0">{children}</h4>
  ),
  h5: ({ children }: { children?: React.ReactNode }) => (
    <h5 className="text-foreground mt-4 mb-1 text-base font-semibold first:mt-0">{children}</h5>
  ),
  h6: ({ children }: { children?: React.ReactNode }) => (
    <h6 className="text-foreground mt-4 mb-1 text-base font-semibold tracking-wide first:mt-0">
      {children}
    </h6>
  ),

  p: ({ children }: { children?: React.ReactNode }) => (
    <div className="text-foreground/95 my-4 leading-relaxed font-medium [overflow-wrap:anywhere] first:mt-0 last:mb-0 [&:has(img)]:my-0">
      {wrapChildrenWithPaths(children)}
    </div>
  ),

  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="marker:text-muted-foreground/60 my-4 list-outside list-disc space-y-1 pl-6 first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0">
      {children}
    </ul>
  ),
  ol: MarkdownOrderedList,
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-foreground/95 leading-relaxed font-medium [overflow-wrap:anywhere]">
      {wrapChildrenWithPaths(children)}
    </li>
  ),

  // Links — brand-blue, routed through next/link. Setup links open an in-app modal.
  a: function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
    const { proxy } = useContext(MarkdownRenderContext);
    const setupLink = parseSetupLinkHref(href);
    if (setupLink) {
      return (
        <SetupLinkButton kind={setupLink.kind} token={setupLink.token}>
          {children}
        </SetupLinkButton>
      );
    }

    // A setup link whose URL is still streaming: the card it will
    // become, with nothing to click yet (see `holdPendingSetupLink`).
    const pendingSetupLink = parsePendingSetupLinkHref(href);
    if (pendingSetupLink) {
      return (
        <SetupLinkButton kind={pendingSetupLink} token={null}>
          {children}
        </SetupLinkButton>
      );
    }

    // The URL is still streaming: show the label in link style, with
    // nothing to click until the real href arrives.
    if (isStreamingLinkPlaceholder(href)) {
      return <span className={LINK_CLASS}>{children}</span>;
    }

    const resolvedHref = proxy(href) ?? href ?? '#';
    const isHash = resolvedHref.startsWith('#');
    const isExternal = !isInternalUrl(resolvedHref);

    // Markdown can contain arbitrary same-origin absolute URLs. Next.js
    // treats those as app routes and prefetches them, including typos such
    // as `/legal/terms.`. Only trusted root-relative/hash paths belong in
    // the app router; every other href stays a plain anchor.
    if (!shouldUseNextLink(resolvedHref)) {
      return (
        <a
          href={resolvedHref}
          className={LINK_CLASS}
          {...(isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
        </a>
      );
    }

    return (
      <Link
        href={resolvedHref}
        onClick={isHash ? (e) => handleHashClick(e, resolvedHref) : undefined}
        className={LINK_CLASS}
        {...(isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
      </Link>
    );
  },

  // Every fence kind and inline code resolve in one shared place; see
  // components/markdown/code. Both this renderer and DocMarkdown pass the
  // parser's props straight through, so the two can no longer drift.
  code: function MarkdownCodeRenderer(props: { children?: React.ReactNode; className?: string }) {
    const { isStreaming } = useContext(MarkdownRenderContext);
    return <MarkdownCode {...props} isStreaming={isStreaming} />;
  },
  // `code` returns the fully-styled block; collapse the default `<pre>` wrapper.
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,

  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-border text-muted-foreground my-5 border-l-2 pl-6 italic [&>p]:my-2">
      {wrapChildrenWithPaths(children)}
    </blockquote>
  ),

  hr: () => <hr className="border-border my-6 h-px border-0 border-t" />,

  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="border-border my-5 overflow-x-auto rounded-md border">
      <table className="!m-0 w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="border-border bg-muted border-b">{children}</thead>
  ),
  tbody: ({ children }: { children?: React.ReactNode }) => (
    <tbody className="divide-border divide-y">{children}</tbody>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => <tr>{children}</tr>,
  // cn() is twMerge: the last same-group class wins. Static classes go
  // last here so an incoming className can't strip whitespace-nowrap/break-normal.
  th: ({
    children,
    className: thClassName,
    node: _node,
    ...props
  }: React.ThHTMLAttributes<HTMLTableCellElement> & { node?: unknown }) => (
    <th
      className={cn(
        thClassName,
        'text-foreground px-4 py-2 text-left font-semibold break-normal whitespace-nowrap',
      )}
      {...props}
    >
      {children}
    </th>
  ),
  td: ({
    children,
    className: tdClassName,
    node: _node,
    ...props
  }: React.TdHTMLAttributes<HTMLTableCellElement> & { node?: unknown }) => (
    <td
      className={cn(tdClassName, 'text-foreground px-4 py-2 text-left font-normal break-normal')}
      {...props}
    >
      {wrapChildrenWithPaths(children)}
    </td>
  ),

  img: function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
    const { proxy, remoteImages } = useContext(MarkdownRenderContext);
    const tHardcodedUi = useTranslations('hardcodedUi');
    const [loadRequested, setLoadRequested] = useState(false);
    if (!src) return null;
    const resolvedSrc = proxy(src) ?? src;
    const remoteHost = remoteImageHost(src, resolvedSrc);
    if (remoteImages === 'click-to-load' && remoteHost && !loadRequested) {
      return (
        <Button
          type="button"
          variant="outline"
          size="xs"
          title={alt || undefined}
          onClick={() => setLoadRequested(true)}
          className="text-muted-foreground max-w-full"
        >
          <ImageIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            {tHardcodedUi('componentsMarkdownUnifiedMarkdown.loadRemoteImage', {
              host: remoteHost,
            })}
          </span>
        </Button>
      );
    }
    return (
      <span className="my-5 block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={resolvedSrc}
          alt={alt || ''}
          loading="lazy"
          className="h-auto max-w-full rounded-lg outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        />
      </span>
    );
  },

  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="text-foreground font-semibold">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="text-foreground/90 italic">{children}</em>
  ),
  del: ({ children }: { children?: React.ReactNode }) => (
    <del className="text-muted-foreground decoration-muted-foreground/50 line-through">
      {children}
    </del>
  ),

  // GFM task-list checkbox.
  input: ({
    checked,
    className: inputClassName,
    node: _node,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { node?: unknown }) => (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      readOnly
      className={cn(
        inputClassName,
        'border-border accent-secondary relative -top-[1px] mr-2 size-4 cursor-default rounded-sm align-middle',
      )}
    />
  ),

  // Raw HTML passthrough (GFM) — leave KaTeX-owned nodes untouched.
  div: ({
    children,
    style,
    className: divClassName,
    node: _node,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { node?: unknown }) => {
    if (isKatexClassName(divClassName)) {
      return (
        <div
          className={normalizeClassName(divClassName)}
          style={style as React.CSSProperties}
          {...props}
        >
          {children}
        </div>
      );
    }
    return (
      <div
        className={cn('text-foreground text-sm', divClassName)}
        style={style as React.CSSProperties}
        {...props}
      >
        {children}
      </div>
    );
  },
  span: ({
    children,
    style,
    className: spanClassName,
    node: _node,
    ...props
  }: React.HTMLAttributes<HTMLSpanElement> & { node?: unknown }) => {
    if (isKatexClassName(spanClassName)) {
      return (
        <span
          className={normalizeClassName(spanClassName)}
          style={style as React.CSSProperties}
          {...props}
        >
          {children}
        </span>
      );
    }
    return (
      <span
        className={cn('text-foreground', spanClassName)}
        style={style as React.CSSProperties}
        {...props}
      >
        {children}
      </span>
    );
  },
};

/**
 * Streamdown's block split, except that a message defining reference-style
 * link targets stays one block, so `[text][1]` can reach `[1]: https://…`.
 * See `hasLinkReferenceDefinition`.
 */
function parseMarkdownBlocks(markdown: string): string[] {
  return hasLinkReferenceDefinition(markdown) ? [markdown] : parseMarkdownIntoBlocks(markdown);
}

export interface UnifiedMarkdownProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  /**
   * Parse embedded raw HTML/SVG into live DOM. Defaults to `true`; set `false`
   * for file/source viewers so markup shows as escaped text instead of broken DOM.
   */
  allowHtml?: boolean;
  /**
   * Set `click-to-load` where the content comes from a third party (scraped
   * pages, connector tool output, public share pages): images hosted outside
   * this app then load only when the reader asks. Defaults to `load`.
   */
  remoteImages?: MarkdownRemoteImages;
}

// Single source of truth for markdown rendering across the app — clean, minimal,
// readable in both themes.
export const UnifiedMarkdown = React.memo<UnifiedMarkdownProps>(
  ({ content, className, isStreaming = false, allowHtml = true, remoteImages = 'load' }) => {
    const tHardcodedUi = useTranslations('hardcodedUi');
    const { proxyUrl } = useSandboxProxy();
    const proxy = useCallback((url: string | undefined) => proxyUrl(url), [proxyUrl]);
    const renderContext = useMemo(
      () => ({ isStreaming, proxy, remoteImages }),
      [isStreaming, proxy, remoteImages],
    );

    // Streamdown renders streaming text block by block and settled text as one
    // document: two different React trees. Switching trees when the turn ends
    // remounts the whole message, the same loss as unstable renderer types
    // above. A message that mounts streaming keeps the block renderer for good;
    // one that mounts settled (history) is parsed as one document.
    const [streamedAtMount] = useState(isStreaming);

    const safeContent = typeof content === 'string' ? content : content ? String(content) : '';

    // Whole-string rewrites (KaTeX prep, system-tag strip, the pending setup
    // link, autolink). Run bare, they re-ran on EVERY render of this component
    // — including every render caused by something other than a new token —
    // for the full length of the answer. Memoising on the string collapses
    // that to once per distinct value. It sits ABOVE the empty-content early
    // return so the hook order stays fixed.
    const finalContent = useMemo(
      () => (safeContent ? prepareMarkdownSource(safeContent, isStreaming) : ''),
      [safeContent, isStreaming],
    );

    if (!safeContent) {
      return (
        <div className={cn('text-muted-foreground text-sm', className)}>
          {tHardcodedUi.raw('componentsMarkdownUnifiedMarkdown.line1115JsxTextNoContent')}
        </div>
      );
    }

    return (
      <div
        className={cn(
          'kortix-markdown max-w-full min-w-0 text-[15px] [overflow-wrap:anywhere]',
          isStreaming && 'streaming-active',
          className,
        )}
        data-streaming={isStreaming ? 'true' : 'false'}
      >
        <MarkdownRenderContext.Provider value={renderContext}>
          <Streamdown
            isAnimating={isStreaming}
            mode={streamedAtMount || isStreaming ? 'streaming' : 'static'}
            // Completing half-written markdown is for text that is still
            // arriving. A settled message renders exactly as written.
            parseIncompleteMarkdown={isStreaming}
            parseMarkdownIntoBlocksFn={parseMarkdownBlocks}
            components={MARKDOWN_COMPONENTS as any}
            remarkPlugins={katexRemarkPlugins}
            // Module-level arrays for the same reason as MARKDOWN_COMPONENTS: a
            // new array each render made every block re-parse on every token.
            rehypePlugins={allowHtml ? katexRehypePlugins : katexRehypePluginsNoRaw}
          >
            {finalContent}
          </Streamdown>
        </MarkdownRenderContext.Provider>
      </div>
    );
  },
);

UnifiedMarkdown.displayName = 'UnifiedMarkdown';
