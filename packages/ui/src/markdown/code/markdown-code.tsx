'use client';

import { ErrorBoundary } from '../../primitives/error-boundary';
import type { MarkdownTrust, MarkdownVariant } from '../markdown-policy';
import { KaTeXBlock } from '../katex-block';
import { KATEX_FENCE_LANGUAGES } from '../katex-markdown';
import { UnifiedMarkdown } from '../unified-markdown';
import { SetupLinkButton } from '../setup-links/setup-link-button';
import { parseSetupLinkHref } from '../setup-links/util';
import { GenuiTelemetryContext, markGenuiWatched } from '../genui/block-telemetry';
import { genuiBlockText } from '../genui/to-markdown';
import { withStaleChunkRecovery } from '../../internal/lib/chunk-reload';
import { isMermaidCode } from '../../internal/lib/mermaid-utils';
import React, { lazy, Suspense, useContext, useEffect, useState } from 'react';

import { childrenToText } from './children-text';
import { CodeBlock, HighlightedCode } from './code-block';
import { genuiVersionFromClassName, readGenuiOpenMark } from './genui-fence';
import { ClickableInlineCode } from './inline-code';

// Mermaid pulls in a multi-hundred-KB renderer; load it only once a diagram exists.
const MermaidRenderer = lazy(() =>
  import('../../primitives/mermaid-renderer').then((mod) => ({
    default: mod.MermaidRenderer,
  })),
);

// Generative UI pulls in lang-core and the block components; load it only once a block exists.
// A stale deploy's missing chunk reloads the tab once (KRTX-1613); any other failure lands on the
// block's own boundary below, never on the chat's.
const GenuiMessageBlock = lazy(withStaleChunkRecovery(() => import('../genui/genui-message-block')));

interface GenuiFenceProps {
  code: string;
  version: number;
  /** This block's fence is still open while the turn works. */
  streaming: boolean;
  /** The turn ended with this block's fence still open. */
  cutOff: boolean;
  trust: MarkdownTrust;
  variant: MarkdownVariant;
}

/**
 * The block as markdown, from the SDK conversion. The converter is a dynamic import; until it
 * answers this renders nothing. When it fails too (a stale deploy's second chunk), the raw fence
 * source shows as a plain code block, so the reader never loses the content.
 */
function GenuiMarkdownFallback({ code, version, streaming, trust, variant }: Omit<GenuiFenceProps, 'cutOff'>) {
  const [markdown, setMarkdown] = useState<string | null>('');
  useEffect(() => {
    let live = true;
    genuiBlockText(code, version, { streaming }).then(
      (text) => live && setMarkdown(text),
      () => live && setMarkdown(null),
    );
    return () => {
      live = false;
    };
  }, [code, version, streaming]);
  if (markdown === null) {
    return (
      <pre className="not-prose bg-popover text-foreground my-5 max-h-[520px] overflow-auto rounded-md border px-4 py-2.5 font-mono text-xs whitespace-pre">
        {code}
      </pre>
    );
  }
  return markdown ? <UnifiedMarkdown content={markdown} trust={trust} variant={variant} /> : null;
}

/**
 * One block's own error boundary: a failed chunk load or a render error replaces this block with
 * its markdown, not the whole chat with the crash card. Exported for its test.
 */
export function GenuiFenceBoundary({ children, ...fence }: Omit<GenuiFenceProps, 'cutOff'> & { children: React.ReactNode }) {
  return <ErrorBoundary fallback={() => <GenuiMarkdownFallback {...fence} />}>{children}</ErrorBoundary>;
}

function GenuiFence({ turnStreaming, ...fence }: GenuiFenceProps & { turnStreaming: boolean }) {
  const telemetry = useContext(GenuiTelemetryContext);
  // Here, not in the lazy chunk: the turn counts as watched even if the chunk arrives after it ends.
  // Idempotent, so a render React discards does no harm.
  if (turnStreaming && telemetry) markGenuiWatched(telemetry.scope);
  return (
    <GenuiFenceBoundary {...fence}>
      {/* History holds a space while the chunk loads (no skeleton: the block grows from it). A
          streaming block starts from nothing, so a reserve would only shrink. */}
      <Suspense fallback={turnStreaming ? null : <div className="my-4 min-h-[160px]" />}>
        <GenuiMessageBlock {...fence} />
      </Suspense>
    </GenuiFenceBoundary>
  );
}

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
  /** Writer trust of the surrounding markdown; generative UI fallbacks render with the same trust. */
  trust?: MarkdownTrust;
  /** Variant of the surrounding markdown; generative UI fallbacks render with the same variant. */
  variant?: MarkdownVariant;
  /** ```openui fences render as generative UI. Off, they are ordinary code blocks. */
  genui?: boolean;
}

// Code — Mermaid and KaTeX fences render their own chrome; everything else goes
// through the shared card. `language || 'text'` routes no-hint fences via Shiki.
export function MarkdownCode({
  children,
  className: codeClassName,
  isStreaming,
  setupLinks = false,
  trust,
  variant = 'message',
  genui = false,
}: MarkdownCodeProps) {
  const match = /language-(\w+)/.exec(codeClassName || '');
  const language = match ? match[1] : '';
  const code = childrenToText(children).replace(/\n$/, '');
  const genuiVersion = genui ? genuiVersionFromClassName(codeClassName) : null;
  if (genuiVersion !== null) {
    // A block streams while its fence is open, so a block the model has closed settles at once
    // (tabs click, strict parse). The open state is the last line of its own text
    // (`closeOpenGenuiFence`): only the fence still open at the end of the reply carries one.
    const fence = readGenuiOpenMark(code);
    return (
      <GenuiFence
        code={fence.code}
        version={genuiVersion}
        streaming={fence.open === 'streaming'}
        cutOff={fence.open === 'cut-off'}
        turnStreaming={Boolean(isStreaming)}
        trust={trust ?? 'untrusted'}
        variant={variant}
      />
    );
  }
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
