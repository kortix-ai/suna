'use client';

import { CodeBlockCode } from '@/components/ui/code-block';
import { useCopy } from '@/hooks/use-copy';
import { cn } from '@/lib/utils';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import Link from 'next/link';
import { type CSSProperties, useState } from 'react';

/**
 * Code surfaces for the developer routes (/v2/sdk, /v2/mcp, /v2/download).
 *
 * Every snippet these render is lifted from the shipped docs, the CLI, or the
 * SDK README. A developer page that shows an API which does not exist is worse
 * than one that shows nothing, so nothing here is written from imagination.
 */

/** Matches the framing `Screenshot` gives a real product shot. */
const FRAME: CSSProperties = {
  border: '1px solid color-mix(in oklab, var(--foreground) 9%, transparent)',
  boxShadow:
    '0 1px 0 color-mix(in oklab, var(--foreground) 6%, transparent), 0 28px 60px -28px color-mix(in oklab, var(--kortix-blue) 55%, transparent)',
};

export type CodeTab = { name: string; language: string; code: string };

export function CodeWindow({ tabs, className }: { tabs: CodeTab[]; className?: string }) {
  const [active, setActive] = useState(0);
  const { copied, copy } = useCopy();
  const tab = tabs[active] ?? tabs[0];

  if (!tab) return null;

  return (
    <div className={cn('bg-card overflow-hidden rounded-[1rem]', className)} style={FRAME}>
      <div className="border-border/70 flex flex-wrap items-center gap-1 border-b px-2 py-2">
        {tabs.map((entry, i) => (
          <button
            key={entry.name}
            type="button"
            onClick={() => setActive(i)}
            className={cn(
              'cursor-pointer rounded-full px-3 py-1 font-mono text-xs transition-colors',
              i === active
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {entry.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => copy(tab.code)}
          aria-label="Copy code"
          className="text-muted-foreground hover:text-foreground ml-auto cursor-pointer rounded-full p-2 transition-colors"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
      </div>

      <div className="text-[13px]">
        <CodeBlockCode
          code={tab.code}
          language={tab.language}
          className="[&_pre]:rounded-none [&_pre]:px-5 [&_pre]:py-5"
        />
      </div>
    </div>
  );
}

/** A single copyable shell command, styled like the one on the live CLI section. */
export function CommandRow({ command, className }: { command: string; className?: string }) {
  const { copied, copy } = useCopy();

  return (
    <div
      className={cn(
        'bg-card flex items-center justify-between gap-4 rounded-[0.85rem] px-5 py-3',
        className,
      )}
      style={FRAME}
    >
      <code className="text-foreground min-w-0 truncate font-mono text-sm select-all">
        <span className="text-muted-foreground/60">$ </span>
        {command}
      </code>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label="Copy command"
        className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer transition-colors"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

/** A row of links into the real reference material. */
export function DocLinks({
  links,
  className,
}: {
  links: { name: string; href: string }[];
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-7 gap-y-2', className)}>
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-muted-foreground hover:text-foreground group inline-flex items-center gap-1 text-[0.9375rem] transition-colors"
        >
          {link.name}
          <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </Link>
      ))}
    </div>
  );
}
