'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { languageLabel } from '@/components/markdown/unified-markdown-utils';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  highlightAsync,
  highlightSync,
  SHIKI_RESET,
  SHIKI_THEME_DARK,
  SHIKI_THEME_LIGHT,
  type CodeThemeName,
} from './shiki-highlighter';

export function HighlightedCode({
  code,
  language,
  children = code,
  unbounded,
}: {
  code: string;
  language: string;
  /** Plain-text fallback before the grammar is ready. Defaults to `code`. */
  children?: React.ReactNode;
  /**
   * Skip Shiki's length clamp. Chat/markdown code blocks keep the clamp — it
   * guards perf against Streamdown remounting this component per streamed
   * token. A surface whose purpose IS showing the complete content (e.g. a
   * request/response log) must never render less than what it actually holds.
   */
  unbounded?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  // Which half of the one palette to draw. There is no third option.
  const theme: CodeThemeName = resolvedTheme === 'dark' ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT;
  const opts = useMemo(() => ({ unbounded }), [unbounded]);
  const [html, setHtml] = useState<string | null>(() => highlightSync(code, language, theme, opts));

  useEffect(() => {
    const sync = highlightSync(code, language, theme, opts);
    if (sync) {
      setHtml(sync);
      return;
    }
    let alive = true;
    highlightAsync(code, language, theme, opts).then((result) => {
      if (alive && result) setHtml(result);
    });
    return () => {
      alive = false;
    };
  }, [code, language, theme, opts]);

  if (html) {
    return <code className={SHIKI_RESET} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <code className="font-mono text-sm leading-[1.65] whitespace-pre">{children}</code>;
}

// Flat code card: rounded-lg surface, dashed header (language + copy), highlighted body.
export function CodeBlock({
  code,
  language,
  children,
  isStreaming,
  className,
}: {
  code: string;
  language: string;
  children: React.ReactNode;
  isStreaming?: boolean;
  className?: string;
}) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const pinRaf = useRef<number | null>(null);

  // Follow the tail while the block is still streaming. Without this the
  // `max-h-[520px]` clamp holds the reader at the top of a block that keeps
  // growing underneath it — the newest lines, the only ones worth watching,
  // stay off-screen until the turn ends.
  //
  // `el.scrollHeight` is a layout read. Doing it once per streamed token in a
  // layout effect forces a synchronous layout flush per delta; scheduling it
  // in `requestAnimationFrame` moves the read to the point the browser is
  // already computing layout for that frame's paint. Cancelling a pending rAF
  // before scheduling a new one collapses several deltas that land in the same
  // frame into the single measurement that frame actually paints.
  useEffect(() => {
    if (!isStreaming) return;
    if (pinRaf.current !== null) cancelAnimationFrame(pinRaf.current);
    pinRaf.current = requestAnimationFrame(() => {
      pinRaf.current = null;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => {
      if (pinRaf.current !== null) {
        cancelAnimationFrame(pinRaf.current);
        pinRaf.current = null;
      }
    };
  }, [isStreaming, code]);

  return (
    <figure
      className={cn(
        'group not-prose bg-card dark:bg-muted relative my-5 overflow-hidden rounded-md border',
        className,
      )}
    >
      <figcaption className="flex min-h-[29.5px] items-center justify-between gap-2 px-2 py-0.5 text-[12px]">
        <span
          data-testid="code-block-language"
          className="text-muted-foreground font-mono font-medium tracking-wide lowercase select-none"
        >
          {languageLabel(language)}
        </span>
        {code && <CopyButton code={code} />}
      </figcaption>
      <pre
        ref={scrollRef}
        className={cn(
          'bg-popover max-h-[520px] overflow-auto py-2.5',
          'text-foreground rounded-t-sm font-mono text-xs leading-[1.65]',
          '[&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs',
          '[&_.shiki]:!bg-transparent [&_span]:border-none [&_span]:!bg-transparent [&_span]:outline-none',
        )}
      >
        {children}
      </pre>
    </figure>
  );
}

// Standalone highlighted code block — bypasses the markdown parser. Used by tool
// views that render raw file content where markdown parsing would interfere.
export function CodeHighlight({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}) {
  return (
    <CodeBlock code={code} language={language} className={cn('my-0', className)}>
      <HighlightedCode code={code} language={language} />
    </CodeBlock>
  );
}
