'use client';

import { useCallback, useEffect, useRef } from 'react';

import type { MarkdownTrust } from '@/components/markdown/markdown-policy';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { track } from '@/lib/track';

import { GenuiPending, webGenuiComponents } from './components';
import { GenuiBlock, type GenuiBlockEvent } from './sdk';
import { useGenuiEnabled } from './use-genui-enabled';

export interface GenuiMessageBlockProps {
  code: string;
  version: number;
  isStreaming: boolean;
  trust: MarkdownTrust;
}

export default function GenuiMessageBlock({ code, version, isStreaming, trust }: GenuiMessageBlockProps) {
  const enabled = useGenuiEnabled();
  // Only blocks the viewer watched stream count: a settled block that remounts (scroll, reload)
  // must not report again. The streaming commit sets it, before GenuiBlock's settle effect runs.
  const sawStreaming = useRef(isStreaming);
  useEffect(() => {
    if (isStreaming) sawStreaming.current = true;
  }, [isStreaming]);

  // Stable per trust level: GenuiBlock re-renders its markdown parts when this identity changes.
  const renderMarkdown = useCallback(
    (markdown: string) => (markdown ? <UnifiedMarkdown content={markdown} trust={trust} /> : null),
    [trust],
  );

  const report = useCallback((event: GenuiBlockEvent) => {
    if (!sawStreaming.current) return;
    track('genui_block', {
      outcome: event.outcome,
      components: event.components.join(','),
      ms_to_first_paint: event.msToFirstPaint ?? -1,
      issue_count: event.issueCount,
      platform: 'web',
    });
  }, []);

  return (
    <div className="my-4" data-genui-block="">
      <GenuiBlock
        code={code}
        version={version}
        streaming={isStreaming}
        enabled={enabled}
        components={webGenuiComponents}
        renderMarkdown={renderMarkdown}
        renderPending={GenuiPending}
        onSettled={report}
      />
    </div>
  );
}
