'use client';

import { useTranslations } from 'next-intl';

import { wrapChildrenWithPaths } from '@/components/common/clickable-path';
import { MarkdownCode } from '@/components/markdown/code';
import {
  buildKatexRehypePlugins,
  isKatexClassName,
  katexRemarkPlugins,
  normalizeClassName,
  prepareMarkdownForKatex,
} from '@/components/markdown/katex-markdown';
import { isInternalUrl, isLinkSafeHref } from '@/components/markdown/unified-markdown-utils';
import { SetupLinkButton } from '@/components/setup-links/setup-link-button';
import { parseSetupLinkHref } from '@/components/setup-links/util';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { cn } from '@/lib/utils';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import { autoLinkUrls } from '@kortix/shared';
import Link from 'next/link';
import React, { useCallback, useMemo } from 'react';
import { Streamdown } from 'streamdown';

function handleHashClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (!href.startsWith('#')) return;
  e.preventDefault();
  document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
}

// Single source of truth for markdown rendering across the app — clean, minimal,
// readable in both themes.
export const UnifiedMarkdown = React.memo<UnifiedMarkdownProps>(
  ({ content, className, isStreaming = false, allowHtml = true }) => {
    const tHardcodedUi = useTranslations('hardcodedUi');
    const { proxyUrl } = useSandboxProxy();
    const proxy = useCallback((url: string | undefined) => proxyUrl(url), [proxyUrl]);

    // Memoize the components object so Block's React.memo sees stable references and
    // only the changed block re-renders during streaming (preserves text selection).
    const components = useMemo(
      () => ({
        // Headings — graduated hierarchy bounded by text-base (h6) → text-xl (h1).
        // Only 3 named sizes live in that range, so deeper levels step down via
        // weight, colour, and top-margin instead.
        h1: ({ children }: { children?: React.ReactNode }) => (
          <h1 className="text-foreground mt-10 mb-4 text-xl font-semibold first:mt-0">
            {children}
          </h1>
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
          <h5 className="text-foreground mt-4 mb-1 text-base font-semibold first:mt-0">
            {children}
          </h5>
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
        ol: ({ children }: { children?: React.ReactNode }) => (
          <ol className="marker:text-muted-foreground/80 my-4 list-outside list-decimal space-y-1 pl-6 marker:font-medium first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0">
            {children}
          </ol>
        ),
        li: ({ children }: { children?: React.ReactNode }) => (
          <li className="text-foreground/95 leading-relaxed font-medium [overflow-wrap:anywhere]">
            {wrapChildrenWithPaths(children)}
          </li>
        ),

        // Links — brand-blue, routed through next/link. Setup links open an in-app modal.
        a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
          const setupLink = parseSetupLinkHref(href);
          if (setupLink) {
            return (
              <SetupLinkButton kind={setupLink.kind} token={setupLink.token}>
                {children}
              </SetupLinkButton>
            );
          }

          const resolvedHref = proxy(href) ?? href ?? '#';
          const isHash = resolvedHref.startsWith('#');
          const isExternal = !isInternalUrl(resolvedHref);
          const linkClass = cn(
            'font-medium text-kortix-blue',
            'underline decoration-kortix-blue/40 decoration-[1px] underline-offset-[3px]',
            'transition-colors hover:decoration-kortix-blue',
            '[overflow-wrap:anywhere]',
          );

          // A malformed absolute href (e.g. `http://:` from an unsubstituted
          // `${HOST}:${PORT}` template in content) must not reach next/link —
          // its prefetch path throws `Cannot prefetch '...'` (see isLinkSafeHref).
          if (!isLinkSafeHref(resolvedHref)) {
            return (
              <a
                href={resolvedHref}
                className={linkClass}
                {...(isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {children}
              </a>
            );
          }

          return (
            <Link
              href={resolvedHref}
              onClick={isHash ? (e) => handleHashClick(e, resolvedHref) : undefined}
              className={linkClass}
              {...(isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {children}
            </Link>
          );
        },

        // Every fence kind and inline code resolve in one shared place; see
        // components/markdown/code. Both this renderer and DocMarkdown pass the
        // parser's props straight through, so the two can no longer drift.
        code: (props: { children?: React.ReactNode; className?: string }) => (
          <MarkdownCode {...props} isStreaming={isStreaming} />
        ),
        // `code` returns the fully-styled block; collapse the default `<pre>` wrapper.
        pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,

        blockquote: ({ children }: { children?: React.ReactNode }) => (
          <blockquote className="border-border text-muted-foreground my-5 border-l-2 pl-6 italic [&>p]:my-2">
            {wrapChildrenWithPaths(children)}
          </blockquote>
        ),

        hr: () => <hr className="border-border/60 my-6 h-px border-0 border-t" />,

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
            className={cn(
              tdClassName,
              'text-foreground px-4 py-2 text-left font-normal break-normal',
            )}
            {...props}
          >
            {wrapChildrenWithPaths(children)}
          </td>
        ),

        img: ({ src, alt }: { src?: string; alt?: string }) => {
          if (!src) return null;
          const resolvedSrc = proxy(src) ?? src;
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
        input: ({ checked, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="border-border accent-secondary relative -top-[1px] mr-2 size-4 cursor-default rounded align-middle"
            {...props}
          />
        ),

        // Raw HTML passthrough (GFM) — leave KaTeX-owned nodes untouched.
        div: ({
          children,
          style,
          className: divClassName,
          ...props
        }: React.HTMLAttributes<HTMLDivElement>) => {
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
          ...props
        }: React.HTMLAttributes<HTMLSpanElement>) => {
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
      }),
      [isStreaming, proxy],
    );

    const safeContent = typeof content === 'string' ? content : content ? String(content) : '';

    if (!safeContent) {
      return (
        <div className={cn('text-muted-foreground text-sm', className)}>
          {tHardcodedUi.raw('componentsMarkdownUnifiedMarkdown.line1115JsxTextNoContent')}
        </div>
      );
    }

    const finalContent = autoLinkUrls(stripKortixSystemTags(prepareMarkdownForKatex(safeContent)));

    return (
      <div
        className={cn(
          'kortix-markdown max-w-full min-w-0 text-[15px] [overflow-wrap:anywhere]',
          isStreaming && 'streaming-active',
          className,
        )}
        data-streaming={isStreaming ? 'true' : 'false'}
      >
        <Streamdown
          isAnimating={isStreaming}
          mode="streaming"
          components={components as any}
          remarkPlugins={katexRemarkPlugins}
          rehypePlugins={allowHtml ? buildKatexRehypePlugins(true) : buildKatexRehypePlugins(false)}
        >
          {finalContent}
        </Streamdown>
      </div>
    );
  },
);

UnifiedMarkdown.displayName = 'UnifiedMarkdown';
