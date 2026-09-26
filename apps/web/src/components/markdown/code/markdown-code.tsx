'use client';

import { KaTeXBlock } from '@/components/markdown/katex-block';
import { KATEX_FENCE_LANGUAGES } from '@/components/markdown/katex-markdown';
import { SetupLinkButton } from '@/components/setup-links/setup-link-button';
import { parseSetupLinkHref } from '@/components/setup-links/util';
import { isMermaidCode } from '@/lib/mermaid-utils';
import React, { lazy, Suspense } from 'react';

import { childrenToText } from './children-text';
import { CodeBlock, HighlightedCode } from './code-block';
import { ClickableInlineCode } from './inline-code';

// Mermaid pulls in a multi-hundred-KB renderer; load it only once a diagram exists.
const MermaidRenderer = lazy(() =>
  import('@/components/ui/mermaid-renderer').then((mod) => ({
    default: mod.MermaidRenderer,
  })),
);

export interface MarkdownCodeProps {
  children?: React.ReactNode;
  className?: string;
  /**
   * The message is still streaming: code blocks pin their scroll to the newest
   * lines, and code blocks and diagrams render once their text holds still.
   */
  isStreaming?: boolean;
  /**
   * Inline code holding a setup link renders the in-app setup card. Only agent
   * content sets this (see `MarkdownPolicy.setupLinks`).
   */
  setupLinks?: boolean;
}

// Code — Mermaid and KaTeX fences render their own chrome; everything else goes
// through the shared card. `language || 'text'` routes no-hint fences via Shiki.
export function MarkdownCode({
  children,
  className: codeClassName,
  isStreaming,
  setupLinks = false,
}: MarkdownCodeProps) {
  const match = /language-(\w+)/.exec(codeClassName || '');
  const language = match ? match[1] : '';
  const code = childrenToText(children).replace(/\n$/, '');
  const isBlock = codeClassName?.includes('language-') || code.includes('\n');

  if (isBlock) {
    if (isMermaidCode(language, code)) {
      return (
        <Suspense fallback={null}>
          <MermaidRenderer chart={code} className="my-5" isStreaming={isStreaming} />
        </Suspense>
      );
    }
    if (KATEX_FENCE_LANGUAGES.has(language.toLowerCase())) {
      return <KaTeXBlock math={code} />;
    }
    return (
      <CodeBlock code={code} language={language} isStreaming={isStreaming}>
        <HighlightedCode code={code} language={language || 'text'} isStreaming={isStreaming}>
          {children}
        </HighlightedCode>
      </CodeBlock>
    );
  }

  // Agents sometimes wrap a setup link in backticks instead of a markdown
  // link — same interception as the markdown `a` renderer, so the human still
  // gets the in-chat form chip instead of a wall of token characters.
  const inlineSetupLink = setupLinks ? parseSetupLinkHref(code.trim()) : null;
  if (inlineSetupLink) {
    return <SetupLinkButton kind={inlineSetupLink.kind} token={inlineSetupLink.token} />;
  }

  return <ClickableInlineCode>{children}</ClickableInlineCode>;
}
