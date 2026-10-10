'use client';

import { useCallback, useContext } from 'react';

import type { MarkdownTrust, MarkdownVariant } from '@/components/markdown/markdown-policy';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';

import { GenuiTelemetryContext, reportGenuiBlock } from './block-telemetry';
import { GenuiPending, webGenuiComponents } from './components';
import { GenuiBlock, type GenuiBlockEvent } from './sdk';
import { useGenuiEnabled } from './use-genui-enabled';

export interface GenuiMessageBlockProps {
  code: string;
  version: number;
  /** This block's fence is still open while the turn works (not the turn's own state). */
  streaming: boolean;
  /** The turn ended with this block's fence still open. */
  cutOff: boolean;
  trust: MarkdownTrust;
  variant: MarkdownVariant;
}

export default function GenuiMessageBlock({ code, version, streaming, cutOff, trust, variant }: GenuiMessageBlockProps) {
  const enabled = useGenuiEnabled();
  const telemetry = useContext(GenuiTelemetryContext);

  // Stable per trust and variant: GenuiBlock re-renders its markdown parts when this identity changes.
  // No `genui`: a fence inside a block's text stays a code block, it never nests a block.
  const renderMarkdown = useCallback(
    (markdown: string) => (markdown ? <UnifiedMarkdown content={markdown} trust={trust} variant={variant} /> : null),
    [trust, variant],
  );

  // GenuiBlock fires once per mount, when the block settles; reportGenuiBlock dedupes across mounts.
  const report = (event: GenuiBlockEvent) => reportGenuiBlock(telemetry, code, event, cutOff);

  return (
    <div className="my-4" data-genui-block="">
      <GenuiBlock
        code={code}
        version={version}
        streaming={streaming}
        enabled={enabled}
        components={webGenuiComponents}
        renderMarkdown={renderMarkdown}
        renderPending={GenuiPending}
        onSettled={report}
      />
    </div>
  );
}
