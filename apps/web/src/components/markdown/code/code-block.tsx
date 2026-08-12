'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { languageLabel } from '@/components/markdown/unified-markdown-utils';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import React, { useEffect, useState } from 'react';

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
}: {
  code: string;
  language: string;
  /** Plain-text fallback before the grammar is ready. Defaults to `code`. */
  children?: React.ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  // Which half of the one palette to draw. There is no third option.
  const theme: CodeThemeName = resolvedTheme === 'dark' ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT;
  const [html, setHtml] = useState<string | null>(() => highlightSync(code, language, theme));

  useEffect(() => {
    const sync = highlightSync(code, language, theme);
    if (sync) {
      setHtml(sync);
      return;
    }
    let alive = true;
    highlightAsync(code, language, theme).then((result) => {
      if (alive && result) setHtml(result);
    });
    return () => {
      alive = false;
    };
  }, [code, language, theme]);

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
  return (
    <div
      className={cn(
        'group not-prose bg-card dark:bg-muted relative my-5 overflow-hidden rounded-md border',
        className,
      )}
    >
      <figcaption className="flex items-center justify-between gap-2 px-2 py-0.5 text-[12px]">
        <span
          data-testid="code-block-language"
          className="text-muted-foreground font-mono font-medium tracking-wide lowercase select-none"
        >
          {languageLabel(language)}
        </span>
        {code && !isStreaming && <CopyButton code={code} />}
      </figcaption>
      <pre
        className={cn(
          'bg-popover max-h-[520px] overflow-auto py-4',
          'text-foreground rounded-t-sm font-mono text-sm leading-[1.65]',
          '[&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit',
          '[&_.shiki]:!bg-transparent [&_span]:border-none [&_span]:!bg-transparent [&_span]:outline-none',
        )}
      >
        {children}
      </pre>
    </div>
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
