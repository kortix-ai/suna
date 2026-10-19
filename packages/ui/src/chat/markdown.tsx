'use client';

import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '../lib/utils';
import { streamingMarkdown } from './streaming-markdown';

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => (
    <ul className="marker:text-muted-foreground my-2 ml-4 list-disc space-y-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="marker:text-muted-foreground my-2 ml-4 list-decimal space-y-1">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-foreground underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="border-border text-muted-foreground my-2 border-l-2 pl-3">{children}</blockquote>
  ),
  hr: () => <hr className="border-border my-3" />,
  code: ({ className, children }) =>
    String(className ?? '').includes('language-') ? (
      <code className="font-mono text-xs">{children}</code>
    ) : (
      <code className="bg-muted rounded-sm px-1.5 py-0.5 font-mono text-xs">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="border-border bg-muted scrollbar-thin my-2 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-border border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-border border px-2 py-1">{children}</td>,
};

/**
 * Assistant markdown (GitHub-flavored), styled by the Kortix tokens.
 * `streaming` holds back a half-written table header or fence opener and
 * closes an open code fence, so a turn in progress never flashes raw syntax.
 */
export const Markdown = memo(function Markdown({
  children,
  className,
  streaming = false,
}: {
  children: string;
  className?: string;
  streaming?: boolean;
}) {
  const text = useMemo(() => (streaming ? streamingMarkdown(children) : children), [children, streaming]);
  if (!text) return null;
  return (
    <div data-slot="markdown" className={cn('text-foreground text-sm leading-relaxed', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
