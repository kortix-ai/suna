'use client';

/**
 * The ONE way a tool view shows raw or lightly-structured output (spec S1).
 * Every bare `<pre>{output}</pre>` in tool/tools/ converts to this, so the
 * grammar (mono, capped scroll, muted wrap) can never drift per-file again.
 */

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';

export function OutputBlock({
  text,
  markdown = false,
  className,
}: {
  text: string;
  markdown?: boolean;
  className?: string;
}) {
  return (
    <div
      data-scrollable
      className={cn(
        'bg-muted/20 max-h-96 overflow-auto rounded-sm px-3 py-2',
        className,
      )}
    >
      {markdown ? (
        <UnifiedMarkdown content={text} />
      ) : (
        <pre className="text-muted-foreground/80 font-mono text-xs break-words whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </div>
  );
}

/** The one sanctioned section label (spec S1) — kills every ad-hoc
 *  sky/amber/executor uppercase treatment. */
export function ToolSection({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <div className="text-muted-foreground/60 text-[10px] font-medium tracking-wider uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

export function ToolField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-muted-foreground/60 shrink-0">{label}</span>
      <span className={cn('text-foreground/80 min-w-0 truncate', mono && 'font-mono')}>
        {value}
      </span>
    </div>
  );
}
