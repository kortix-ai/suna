import { CodeBlock } from '@/components/markdown/code/code-block';
import { HexColorCode, INLINE_CODE, isHexColor } from '@/components/markdown/code/inline-chip';
import { DocsMermaid } from '@/components/markdown/docs-mermaid';
import { isInternalUrl } from '@/components/markdown/unified-markdown-utils';
import { cn } from '@/lib/utils';
import { Callout as FumadocsCallout } from 'fumadocs-ui/components/callout';
import Link from 'next/link';
import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from 'react';

// Visual parity with unified-markdown.tsx (the canonical markdown renderer)
// — when that file's styles change, mirror them here. This map restyles
// fumadocs MDX output (server-rendered, no 'use client') to the app's
// markdown look: same heading scale, paragraph voice, list markers, kortix-blue
// links, inline-code chips, tables, images, blockquote, hr and strong/em/del
// — minus app-only interactivity (sandbox proxy, file-preview clicks, setup
// links, KaTeX, Mermaid, streaming). Code blocks render through the app's own
// CodeBlock shell (language header + copy button) — the `pre` override below
// keeps rehype-code's server-rendered dual-theme shiki spans as the body, so
// static HTML still carries syntax colors and dark mode stays pure CSS.

const linkClass = cn(
  'font-medium text-kortix-blue',
  'underline decoration-kortix-blue/40 decoration-[1px] underline-offset-[3px]',
  'transition-colors hover:decoration-kortix-blue',
  '[overflow-wrap:anywhere]',
);

// By the time the `pre` override runs, rehype-code has replaced the fence's
// text with token spans — walk them back down to the raw string so the app
// CodeBlock's copy button has something to put on the clipboard.
function flattenToText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenToText).join('');
  if (isValidElement(node)) return flattenToText((node.props as { children?: ReactNode }).children);
  return '';
}

export const docsMdxComponents = {
  // ```mermaid fences arrive as <Mermaid chart="..."/> via remarkMdxMermaid
  // (source.config.ts) and render as live client-side diagrams.
  Mermaid: ({ chart }: { chart: string }) => <DocsMermaid chart={chart} />,

  // Fumadocs' Callout ships with shadow-md baked in — the docs surface is flat.
  Callout: ({ className, ...props }: ComponentPropsWithoutRef<typeof FumadocsCallout>) => (
    <FumadocsCallout {...props} className={cn('shadow-none', className)} />
  ),

  // Headings — unified's graduated hierarchy plus `scroll-mt-24` (anchor
  // targets under the sticky nav). Props are spread so rehype heading ids
  // survive — the TOC and #anchors depend on them.
  h1: ({ children, ...props }: ComponentPropsWithoutRef<'h1'>) => (
    <h1
      className="text-foreground mt-10 mb-4 scroll-mt-24 text-xl font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: ComponentPropsWithoutRef<'h2'>) => (
    <h2
      className="text-foreground mt-8 mb-3 scroll-mt-24 text-xl font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: ComponentPropsWithoutRef<'h3'>) => (
    <h3
      className="text-foreground mt-6 mb-2 scroll-mt-24 text-lg font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: ComponentPropsWithoutRef<'h4'>) => (
    <h4
      className="text-foreground mt-6 mb-2 scroll-mt-24 text-lg font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),
  h5: ({ children, ...props }: ComponentPropsWithoutRef<'h5'>) => (
    <h5
      className="text-foreground mt-4 mb-1 scroll-mt-24 text-base font-semibold first:mt-0"
      {...props}
    >
      {children}
    </h5>
  ),
  h6: ({ children, ...props }: ComponentPropsWithoutRef<'h6'>) => (
    <h6
      className="text-foreground mt-4 mb-1 scroll-mt-24 text-base font-semibold tracking-wide first:mt-0"
      {...props}
    >
      {children}
    </h6>
  ),

  p: ({ children }: ComponentPropsWithoutRef<'p'>) => (
    <p className="text-foreground/95 my-4 leading-relaxed font-medium first:mt-0 last:mb-0 [&:has(img)]:my-0">
      {children}
    </p>
  ),

  ul: ({ children }: ComponentPropsWithoutRef<'ul'>) => (
    <ul className="marker:text-muted-foreground/60 my-4 list-outside list-disc space-y-1 pl-6 first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }: ComponentPropsWithoutRef<'ol'>) => (
    <ol className="marker:text-muted-foreground/80 my-4 list-outside list-decimal space-y-1 pl-6 marker:font-medium first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }: ComponentPropsWithoutRef<'li'>) => (
    <li className="text-foreground/95 leading-relaxed font-medium">{children}</li>
  ),

  a: ({ href, children }: ComponentPropsWithoutRef<'a'>) => {
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
  //
  // `INLINE_CODE` itself, not a copy of it. This file used to carry its own
  // near-miss of the same class string (`rounded-sm`, `bg-muted`, `px-1.5`),
  // so a docs page and a chat message drew visibly different chips for the
  // same backticks and every tune to one silently skipped the other — the
  // chip's baseline fix among them (see `code/inline-code.tsx`).
  code: ({ children, ...props }: ComponentPropsWithoutRef<'code'>) => {
    if (typeof children === 'string' && !children.includes('\n')) {
      // A docs page quoting `#0ea5e9` is as unreadable as a message quoting
      // it, so the swatch is the shared component rather than a chat-only
      // flourish. Everything else `ClickableInlineCode` does — file previews,
      // URL links — is session behaviour and deliberately stays out of docs.
      const text = children.trim();
      if (isHexColor(text)) return <HexColorCode hex={text}>{children}</HexColorCode>;
      return <code className={INLINE_CODE}>{children}</code>;
    }
    return <code {...props}>{children}</code>;
  },

  // The app's CodeBlock shell (language header + copy button, popover surface)
  // around rehype-code's pre-highlighted <code>. The original pre's className
  // carries shiki's `.shiki` marker — merged onto the <code> so fumadocs'
  // shiki.css keeps supplying the dual-theme token colors and `.line` padding,
  // the same rules the client-highlighted app blocks already lean on.
  pre: ({ className, children }: ComponentPropsWithoutRef<'pre'>) => {
    const codeElement = Children.toArray(children).find(isValidElement) as
      | ReactElement<ComponentPropsWithoutRef<'code'>>
      | undefined;
    const childClassName = codeElement?.props.className ?? '';
    // `language-*` on the <code> comes from `addLanguageClass` in
    // source.config.ts — rehype-code emits no language anywhere else.
    const language = /language-([\w+#.-]+)/.exec(String(childClassName))?.[1] ?? 'text';
    return (
      <CodeBlock code={flattenToText(children)} language={language}>
        {codeElement
          ? cloneElement(codeElement, { className: cn(childClassName, className) })
          : children}
      </CodeBlock>
    );
  },

  blockquote: ({ children }: ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote className="border-border text-muted-foreground my-5 border-l-2 pl-6 italic [&>p]:my-2">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="border-border my-6 h-px border-0 border-t" />,

  // `not-prose` opts the whole table out of fumadocs' prose styles, which
  // give the <table> its own border + radius — doubled against this wrapper.
  // border-collapse is required once prose is off (UA default border-spacing
  // would open gaps between the divide-y row lines).
  // Table lines run at 70% of the docs border token — full strength reads
  // heavy against the dense cell grid.
  table: ({ children }: ComponentPropsWithoutRef<'table'>) => (
    <div className="border-border/70 not-prose my-5 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: ComponentPropsWithoutRef<'thead'>) => (
    <thead className="border-border/70 bg-muted border-b">{children}</thead>
  ),
  tbody: ({ children }: ComponentPropsWithoutRef<'tbody'>) => (
    <tbody className="divide-border/70 divide-y">{children}</tbody>
  ),
  tr: ({ children }: ComponentPropsWithoutRef<'tr'>) => <tr>{children}</tr>,
  th: ({ children }: ComponentPropsWithoutRef<'th'>) => (
    <th className="text-foreground px-4 py-2 text-left font-semibold">{children}</th>
  ),
  td: ({ children }: ComponentPropsWithoutRef<'td'>) => (
    <td className="text-foreground px-4 py-2 text-left font-normal">{children}</td>
  ),

  img: ({ src, alt }: ComponentPropsWithoutRef<'img'>) => {
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

  strong: ({ children }: ComponentPropsWithoutRef<'strong'>) => (
    <strong className="text-foreground font-semibold">{children}</strong>
  ),
  em: ({ children }: ComponentPropsWithoutRef<'em'>) => (
    <em className="text-foreground/90 italic">{children}</em>
  ),
  del: ({ children }: ComponentPropsWithoutRef<'del'>) => (
    <del className="text-muted-foreground decoration-muted-foreground/50 line-through">
      {children}
    </del>
  ),
};
