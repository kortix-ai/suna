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

/**
 * How long a streaming block's text must hold still before it is highlighted.
 *
 * The block that is still arriving changes on every paced render, and
 * tokenizing it each time was the dominant cost of streaming a code answer
 * (Shiki re-ran over the whole block per delta batch, and its cache never hit
 * because the key moved with the text). A block renders as plain text while it
 * grows and highlights once it stops — when its fence closes and the message
 * moves on, or at once when the stream ends.
 */
export const CODE_SETTLE_MS = 400;

/** `value` once it has held still for `delayMs` while `active`; `value` when not active; else null. */
function useSettledValue(value: string, active: boolean, delayMs: number): string | null {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, active, delayMs]);
  if (!active) return value;
  return settled === value ? value : null;
}

interface HighlightResult {
  code: string;
  language: string;
  theme: CodeThemeName;
  html: string;
}

export function HighlightedCode({
  code,
  language,
  children = code,
  unbounded,
  isStreaming = false,
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
  /**
   * The message this block belongs to is still streaming. The block renders
   * plain while its text changes and highlights once it holds still for
   * `CODE_SETTLE_MS` (see there).
   */
  isStreaming?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  // Which half of the one palette to draw. There is no third option.
  const theme: CodeThemeName = resolvedTheme === 'dark' ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT;
  const opts = useMemo(() => ({ unbounded }), [unbounded]);
  const target = useSettledValue(code, isStreaming, CODE_SETTLE_MS);
  const [result, setResult] = useState<HighlightResult | null>(null);

  useEffect(() => {
    if (target === null) return;
    if (highlightSync(target, language, theme, opts)) return; // rendered synchronously below
    let alive = true;
    highlightAsync(target, language, theme, opts).then((html) => {
      if (alive && html) setResult({ code: target, language, theme, html });
    });
    return () => {
      alive = false;
    };
  }, [target, language, theme, opts]);

  // A settled block reads its HTML synchronously from the cache (or the loaded
  // grammar) during render, so a remount never flashes plain → colour. Only a
  // grammar that is not loaded yet goes through the async result above.
  const html =
    target === null
      ? null
      : (highlightSync(target, language, theme, opts) ??
        (result &&
        result.code === target &&
        result.language === language &&
        result.theme === theme
          ? result.html
          : null));

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
          'bg-popover max-h-[520px] overflow-auto px-4 py-2.5 tracking-tight',
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
