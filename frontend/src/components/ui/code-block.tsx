'use client';

import { cn } from '@/lib/utils';
import React, { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';
import { useTheme } from 'next-themes';
import { MermaidRenderer } from './mermaid-renderer';

export type CodeBlockProps = {
  children?: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div className={cn('w-px flex-grow min-w-0 overflow-hidden flex', className)} {...props}>
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

  // Use github-dark when in dark mode, github-light when in light mode
  const theme =
    propTheme || (resolvedTheme === 'dark' ? 'github-dark' : 'github-light');

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
        theme,
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
  }, [code, language, theme, mermaidFailed]);

  const classNames = cn('[&_pre]:!bg-background/95 [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:!overflow-x-auto [&_pre]:!w-px [&_pre]:!flex-grow [&_pre]:!min-w-0 [&_pre]:!box-border [&_.shiki]:!overflow-x-auto [&_.shiki]:!w-px [&_.shiki]:!flex-grow [&_.shiki]:!min-w-0 [&_code]:!min-w-0 [&_code]:!whitespace-pre', 'w-px flex-grow min-w-0 overflow-hidden flex w-full', className);

  // Handle Mermaid rendering
  if (language === 'mermaid' && !mermaidFailed) {
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

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>;

function CodeBlockGroup({
  children,
  className,
  ...props
}: CodeBlockGroupProps) {
  return (
    <div className={cn('', className)} {...props}>
      {children}
    </div>
  );
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock };
