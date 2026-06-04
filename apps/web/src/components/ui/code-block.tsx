'use client';

import { cn } from '@/lib/utils';
import React, { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';
import { useTheme } from 'next-themes';
import { MermaidRenderer } from './mermaid-renderer';
import { SHIKI_THEMES, resolveShikiThemeName } from '@/lib/shiki-theme';

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  theme?: string;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlockCode({
  code,
  language = 'tsx',
  theme: propTheme,
  className,
  ...props
}: CodeBlockCodeProps) {
  const { resolvedTheme } = useTheme();
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  // Project-wide Pierre theme (overridable via `theme` prop).
  const themeName = propTheme || resolveShikiThemeName(resolvedTheme);
  const themeInput = propTheme
    ? propTheme
    : (resolvedTheme === 'dark' ? SHIKI_THEMES.dark : SHIKI_THEMES.light);

  // Regular syntax highlighting effect
  useEffect(() => {
    // Mermaid is rendered by MermaidRenderer instead of Shiki.
    if (language === 'mermaid') {
      return;
    }

    async function highlight() {
      if (!code || typeof code !== 'string') {
        setHighlightedHtml(null);
        return;
      }
      const html = await codeToHtml(code, {
        lang: language,
        theme: themeInput as never,
        transformers: [
          {
            pre(node) {
              if (node.properties.style) {
                node.properties.style = (node.properties.style as string)
                  .replace(/background-color:[^;]+;?/g, '');
              }
            }
          }
        ]
      });
      setHighlightedHtml(html);
    }
    highlight();
  }, [code, language, themeInput, themeName]);

  const classNames = cn('[&_pre]:!bg-background/95 [&_pre]:rounded-2xl [&_pre]:p-4 [&_pre]:!overflow-x-auto [&_pre]:!w-px [&_pre]:!flex-grow [&_pre]:!min-w-0 [&_pre]:!box-border [&_.shiki]:!overflow-x-auto [&_.shiki]:!w-px [&_.shiki]:!flex-grow [&_.shiki]:!min-w-0 [&_code]:!min-w-0 [&_code]:!whitespace-pre', 'w-px flex-grow min-w-0 overflow-hidden flex w-full', className);

  // Handle Mermaid rendering
  if (language === 'mermaid') {
    return (
      <MermaidRenderer 
        chart={code}
        className={className}
      />
    );
  }

  // Regular code rendering (including failed Mermaid)
  return highlightedHtml ? (
    <div
      className={classNames}
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      {...props}
    />
  ) : (
    <div className={classNames} {...props}>
      <pre className="!overflow-x-auto !w-px !flex-grow !min-w-0 !box-border">
        <code>{code}</code>
      </pre>
    </div>
  );
}
export { CodeBlockCode };
