'use client';

import { ClientErrorBoundary } from '@/components/common/error-boundary';
import type { MarkdownTrust, MarkdownVariant } from '@/components/markdown/markdown-policy';
import { KaTeXBlock } from '@/components/markdown/katex-block';
import { KATEX_FENCE_LANGUAGES } from '@/components/markdown/katex-markdown';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { SetupLinkButton } from '@/components/setup-links/setup-link-button';
import { parseSetupLinkHref } from '@/components/setup-links/util';
import { GenuiTelemetryContext, markGenuiWatched } from '@/features/genui/block-telemetry';
import { genuiBlockText } from '@/features/genui/to-markdown';
import { withStaleChunkRecovery } from '@/lib/chunk-reload';
import { isMermaidCode } from '@/lib/mermaid-utils';
import React, { lazy, Suspense, useContext, useEffect, useState } from 'react';

import { childrenToText } from './children-text';
import { CodeBlock, HighlightedCode } from './code-block';
import { genuiVersionFromClassName } from './genui-fence';
import { ClickableInlineCode } from './inline-code';

// Mermaid pulls in a multi-hundred-KB renderer; load it only once a diagram exists.
const MermaidRenderer = lazy(() =>
  import('@/components/ui/mermaid-renderer').then((mod) => ({
    default: mod.MermaidRenderer,
  })),
);

// Generative UI pulls in lang-core and the block components; load it only once a block exists.
// A stale deploy's missing chunk reloads the tab once (KRTX-1613); any other failure lands on the
// block's own boundary below, never on the chat's.
const GenuiMessageBlock = lazy(withStaleChunkRecovery(() => import('@/features/genui/genui-message-block')));

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
 * answers, or when it fails too, this renders nothing: never the OpenUI source.
 */
function GenuiMarkdownFallback({ code, version, streaming, trust, variant }: Omit<GenuiFenceProps, 'cutOff'>) {
  const [markdown, setMarkdown] = useState('');
  useEffect(() => {
    let live = true;
    genuiBlockText(code, version, { streaming }).then(
      (text) => live && setMarkdown(text),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [code, version, streaming]);
  return markdown ? <UnifiedMarkdown content={markdown} trust={trust} variant={variant} /> : null;
}

/**
 * One block's own error boundary: a failed chunk load or a render error replaces this block with
 * its markdown, not the whole chat with the crash card. Exported for its test.
 */
export function GenuiFenceBoundary({ children, ...fence }: Omit<GenuiFenceProps, 'cutOff'> & { children: React.ReactNode }) {
  return <ClientErrorBoundary fallback={() => <GenuiMarkdownFallback {...fence} />}>{children}</ClientErrorBoundary>;
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
  /** Body of the generative UI fence still open at the end of the message (`openGenuiFence`). */
  genuiOpenCode?: string | null;
  /** That open fence is nested (blockquote, list-marker line), so its block cannot be told apart. */
  genuiOpenNested?: boolean;
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
  genuiOpenCode = null,
  genuiOpenNested = false,
}: MarkdownCodeProps) {
  const match = /language-(\w+)/.exec(codeClassName || '');
  const language = match ? match[1] : '';
  const code = childrenToText(children).replace(/\n$/, '');
  const genuiVersion = genui ? genuiVersionFromClassName(codeClassName) : null;
  if (genuiVersion !== null) {
    // Only the last block's fence can be open. A block streams while it is open and the turn
    // works, so a block the model has closed settles at once (tabs click, strict parse). A nested
    // open fence cannot be matched to its block: then every block streams with the turn.
    const open = genuiOpenCode !== null && genuiOpenCode.trimEnd() === code.trimEnd();
    return (
      <GenuiFence
        code={code}
        version={genuiVersion}
        streaming={Boolean(isStreaming) && (open || genuiOpenNested)}
        cutOff={!isStreaming && open}
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
