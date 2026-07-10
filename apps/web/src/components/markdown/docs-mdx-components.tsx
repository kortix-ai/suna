import { isInternalUrl } from '@/components/markdown/unified-markdown-utils';
import { cn } from '@/lib/utils';
import { Callout as FumadocsCallout } from 'fumadocs-ui/components/callout';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import Link from 'next/link';
import type { ComponentProps } from 'react';

// Visual parity with doc-markdown.tsx (the docs-owned copy of the app
// renderer) — when that file's styles change, mirror them here. This map
// restyles fumadocs MDX output (server-rendered, no 'use client') to the
// app's markdown look: same heading scale, paragraph voice, list markers,
// kortix-blue links, inline-code chips, tables, images, blockquote, hr and
// strong/em/del — minus app-only interactivity (sandbox proxy, file-preview
// clicks, setup links, KaTeX, Mermaid, streaming). Code blocks stay on
// fumadocs' native CodeBlock (copy button, title bar) — the `pre` override
// below only flattens its chrome to the app surface (rounded-md, no shadow).

const linkClass = cn(
  'font-medium text-kortix-blue',
  'underline decoration-kortix-blue/40 decoration-[1px] underline-offset-[3px]',
  'transition-colors hover:decoration-kortix-blue',
  '[overflow-wrap:anywhere]',
);

// Inline-code chip — unified-markdown's INLINE_CODE at its non-clickable size.
const inlineCodeClass =
  'rounded-sm border border-border/40 bg-muted px-1.5 py-[0.1rem] font-mono text-[0.8rem] text-foreground/95 dark:bg-card';

export const docsMdxComponents = {
  // Fumadocs' Callout ships with shadow-md baked in — the docs surface is flat.
  Callout: ({ className, ...props }: ComponentProps<typeof FumadocsCallout>) => (
    <FumadocsCallout {...props} className={cn('shadow-none', className)} />
  ),

  // Headings — unified's graduated hierarchy plus `scroll-mt-24` (anchor
  // targets under the sticky nav). Props are spread so rehype heading ids
  // survive — the TOC and #anchors depend on them.
  h1: ({ children, ...props }: ComponentProps<'h1'>) => (
    <h1
      className="text-foreground mt-10 mb-4 scroll-mt-24 text-xl font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: ComponentProps<'h2'>) => (
    <h2
      className="text-foreground mt-8 mb-3 scroll-mt-24 text-xl font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: ComponentProps<'h3'>) => (
    <h3
      className="text-foreground mt-6 mb-2 scroll-mt-24 text-lg font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: ComponentProps<'h4'>) => (
    <h4
      className="text-foreground mt-6 mb-2 scroll-mt-24 text-lg font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),
  h5: ({ children, ...props }: ComponentProps<'h5'>) => (
    <h5
      className="text-foreground mt-4 mb-1 scroll-mt-24 text-base font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h5>
  ),
  h6: ({ children, ...props }: ComponentProps<'h6'>) => (
    <h6
      className="text-foreground mt-4 mb-1 scroll-mt-24 text-base font-semibold tracking-wide first:mt-0"
      {...props}
    >
      {children}
    </h6>
  ),

  p: ({ children }: ComponentProps<'p'>) => (
    <p className="text-foreground/95 my-4 leading-relaxed font-medium first:mt-0 last:mb-0 [&:has(img)]:my-0">
      {children}
    </p>
  ),

  ul: ({ children }: ComponentProps<'ul'>) => (
    <ul className="marker:text-muted-foreground/60 my-4 list-outside list-disc space-y-1 pl-6 first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }: ComponentProps<'ol'>) => (
    <ol className="marker:text-muted-foreground/80 my-4 list-outside list-decimal space-y-1 pl-6 marker:font-medium first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }: ComponentProps<'li'>) => (
    <li className="text-foreground/95 leading-relaxed font-medium">{children}</li>
  ),

  a: ({ href, children }: ComponentProps<'a'>) => {
    const resolvedHref = href ?? '#';
    const isHash = resolvedHref.startsWith('#');
    const isExternal = !isInternalUrl(resolvedHref);
    return (
      <Link
        href={resolvedHref}
        className={linkClass}
        {...(isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {children}
      </Link>
    );
  },

  // Inline code becomes the bordered chip; multiline/block code is the shiki
  // <code> inside <pre> — pass it through untouched for fumadocs' CodeBlock.
  code: ({ children, ...props }: ComponentProps<'code'>) => {
    if (typeof children === 'string' && !children.includes('\n')) {
      return <code className={inlineCodeClass}>{children}</code>;
    }
    return <code {...props}>{children}</code>;
  },

  // Fumadocs' native CodeBlock (copy button, fence titles), flattened to the
  // app surface: its stock chrome is rounded-xl + shadow-sm.
  pre: ({ className, children, ...props }: ComponentProps<'pre'>) => (
    <CodeBlock {...props} className={cn(className, 'rounded-md shadow-none')}>
      <Pre>{children}</Pre>
    </CodeBlock>
  ),

  blockquote: ({ children }: ComponentProps<'blockquote'>) => (
    <blockquote className="border-border text-muted-foreground my-5 border-l-2 pl-6 italic [&>p]:my-2">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="border-border/60 my-6 h-px border-0 border-t" />,

  // `not-prose` opts the whole table out of fumadocs' prose styles, which
  // give the <table> its own border + radius — doubled against this wrapper.
  // border-collapse is required once prose is off (UA default border-spacing
  // would open gaps between the divide-y row lines).
  // Table lines run at 70% of the docs border token — full strength reads
  // heavy against the dense cell grid.
  table: ({ children }: ComponentProps<'table'>) => (
    <div className="border-border/70 not-prose my-5 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: ComponentProps<'thead'>) => (
    <thead className="border-border/70 bg-muted border-b">{children}</thead>
  ),
  tbody: ({ children }: ComponentProps<'tbody'>) => (
    <tbody className="divide-border/70 divide-y">{children}</tbody>
  ),
  tr: ({ children }: ComponentProps<'tr'>) => <tr>{children}</tr>,
  th: ({ children }: ComponentProps<'th'>) => (
    <th className="text-foreground px-4 py-2 text-left font-semibold">{children}</th>
  ),
  td: ({ children }: ComponentProps<'td'>) => (
    <td className="text-foreground px-4 py-2 text-left font-normal">{children}</td>
  ),

  img: ({ src, alt }: ComponentProps<'img'>) => {
    if (!src || typeof src !== 'string') return null;
    return (
      <span className="my-5 block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt || ''}
          loading="lazy"
          className="h-auto max-w-full rounded-lg outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        />
      </span>
    );
  },

  strong: ({ children }: ComponentProps<'strong'>) => (
    <strong className="text-foreground font-semibold">{children}</strong>
  ),
  em: ({ children }: ComponentProps<'em'>) => (
    <em className="text-foreground/90 italic">{children}</em>
  ),
  del: ({ children }: ComponentProps<'del'>) => (
    <del className="text-muted-foreground decoration-muted-foreground/50 line-through">
      {children}
    </del>
  ),
};
