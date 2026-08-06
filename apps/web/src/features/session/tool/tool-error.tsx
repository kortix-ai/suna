'use client';

import { parseErrorContent } from '@/features/session/tool/shared/error-and-connector';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import { StructuredOutput } from '@/features/session/tool/shared/structured-output';
import { cn } from '@/lib/utils';
import {
  hasStructuredContent,
  normalizeToolOutput,
  parseStructuredOutput,
} from '@/lib/utils/structured-output';
import {
  ProhibitIcon as Ban,
  CaretRightIcon as ChevronRight,
  WarningCircleIcon as CircleAlert,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

export function ToolError({ error, toolName }: { error: string; toolName?: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [showTrace, setShowTrace] = useState(false);

  const structuredSections = useMemo(() => {
    const normalized = normalizeToolOutput(error);
    if (!hasStructuredContent(normalized)) return null;
    return parseStructuredOutput(normalized);
  }, [error]);

  const { summary, traceback, errorType, validationIssues } = useMemo(
    () => parseErrorContent(normalizeToolOutput(error)),
    [error],
  );

  const displayType = errorType || 'Error';

  if (structuredSections) {
    return (
      <ToolResultCard>
        <div className="px-1 py-0.5 text-xs">
          <StructuredOutput sections={structuredSections} />
        </div>
      </ToolResultCard>
    );
  }

  if (validationIssues && validationIssues.length > 0) {
    return (
      <ToolResultCard>
        {/* The header rule is gone: inside a bordered card a full-bleed
				    hairline cannot reach the edges (the card's `p-1` holds it off),
				    so it read as a line that stopped short rather than a divider.
				    Spacing separates the header from the issues instead. */}
        <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs">
          <Ban className="text-muted-foreground/70 size-3.5 flex-shrink-0" />
          <span className="text-muted-foreground font-medium">{displayType}</span>
          {toolName && (
            <span className="text-muted-foreground/50 ml-auto font-mono">{toolName}</span>
          )}
        </div>

        <div className="space-y-2.5 px-2 pt-1 pb-2">
          {validationIssues.map((issue, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-start gap-2">
                <CircleAlert className="text-muted-foreground/60 mt-0.5 size-3.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  {issue.path.length > 0 && (
                    <span className="bg-muted/60 text-muted-foreground/70 mr-1.5 rounded-sm px-1.5 py-0.5 font-mono text-xs">
                      {issue.path.join('.')}
                    </span>
                  )}
                  <span className="text-foreground/80 text-xs">{issue.message}</span>
                </div>
              </div>

              {issue.values && issue.values.length > 0 && (
                <div className="ml-5.5">
                  <div className="text-muted-foreground/50 mb-1 text-xs">
                    {tHardcodedUi.raw(
                      'componentsSessionToolRenderers.line7845JsxTextExpectedOneOf',
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {issue.values.map((val, vi) => (
                      <span
                        key={vi}
                        className="bg-muted/40 text-muted-foreground/70 rounded-sm px-1.5 py-0.5 font-mono text-xs"
                      >
                        {val}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </ToolResultCard>
    );
  }

  return (
    <ToolResultCard>
      <p className="text-muted-foreground/80 px-2 py-1.5 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
        {summary}
      </p>
      {traceback && (
        <>
          {/* A disclosure row, so it gets the same rounded hover the result
					    rows have rather than reading as a bare link. */}
          <button
            type="button"
            onClick={() => setShowTrace((v) => !v)}
            className="text-muted-foreground/60 hover:text-foreground hover:bg-muted flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-left transition-colors duration-150"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', showTrace && 'rotate-90')}
            />
            <span className="text-xs font-medium">
              {tHardcodedUi.raw('componentsSessionToolRenderers.line7883JsxTextStackTrace')}
            </span>
          </button>
          {/* No `max-h` of its own — the card already scrolls, and a scroll
					    area inside a scroll area hides the end of the trace behind a
					    gesture nobody thinks to make. */}
          {showTrace && (
            <pre className="text-muted-foreground/50 px-2 pb-1.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
              {traceback}
            </pre>
          )}
        </>
      )}
    </ToolResultCard>
  );
}
