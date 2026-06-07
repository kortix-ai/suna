'use client';

import { SHIKI_THEMES, resolveShikiThemeName } from '@/lib/shiki-theme';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import React, { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';
import { MermaidRenderer } from './mermaid-renderer';

export type CodeBlockProps = {
  children?: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div className={cn('flex w-px min-w-0 flex-grow overflow-hidden', className)} {...props}>
      {children}
    </div>
  );
}

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
  const [mermaidFailed, setMermaidFailed] = useState(false);

  // Project-wide Pierre theme (overridable via `theme` prop).
  const themeName = propTheme || resolveShikiThemeName(resolvedTheme);
  const themeInput = propTheme
    ? propTheme
    : resolvedTheme === 'dark'
      ? SHIKI_THEMES.dark
      : SHIKI_THEMES.light;

  // Regular syntax highlighting effect
  useEffect(() => {
    // Skip syntax highlighting for successful mermaid renders
    if (language === 'mermaid' && !mermaidFailed) {
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
                node.properties.style = (node.properties.style as string).replace(
                  /background-color:[^;]+;?/g,
                  '',
                );
              }
            },
          },
        ],
      });
      setHighlightedHtml(html);
    }
    highlight();
  }, [code, language, themeInput, themeName, mermaidFailed]);

  const classNames = cn(
    '[&_pre]:!bg-background/95 [&_pre]:rounded-2xl [&_pre]:p-4 [&_pre]:!overflow-x-auto [&_pre]:!w-px [&_pre]:!flex-grow [&_pre]:!min-w-0 [&_pre]:!box-border [&_.shiki]:!overflow-x-auto [&_.shiki]:!w-px [&_.shiki]:!flex-grow [&_.shiki]:!min-w-0 [&_code]:!min-w-0 [&_code]:!whitespace-pre',
    'w-px flex-grow min-w-0 overflow-hidden flex w-full',
    className,
  );

  // Handle Mermaid rendering
  if (language === 'mermaid' && !mermaidFailed) {
    return <MermaidRenderer chart={code} className={className} />;
  }

  // Regular code rendering (including failed Mermaid)
  return highlightedHtml ? (
    <div className={classNames} dangerouslySetInnerHTML={{ __html: highlightedHtml }} {...props} />
  ) : (
    <div className={classNames} {...props}>
      <pre className="!box-border !w-px !min-w-0 !flex-grow !overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>;

function CodeBlockGroup({ children, className, ...props }: CodeBlockGroupProps) {
  return (
    <div className={cn('', className)} {...props}>
      {children}
    </div>
  );
}

export { CodeBlock, CodeBlockCode, CodeBlockGroup };
