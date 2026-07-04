'use client';

import { StructuredOutput } from '@/features/session/tool/shared/structured-output';
import { parseErrorContent } from '@/features/session/tool/shared/error-and-executor';
import {
  hasStructuredContent,
  normalizeToolOutput,
  parseStructuredOutput,
} from '@/lib/utils/structured-output';
import { Ban, ChevronRight, CircleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

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
      <div className="text-xs">
        <StructuredOutput sections={structuredSections} />
      </div>
    );
  }

  if (validationIssues && validationIssues.length > 0) {
    return (
      <div className="overflow-hidden text-xs">
        <div className="border-border/40 flex items-center gap-2 border-b px-3 py-2">
          <Ban className="text-muted-foreground/70 size-3 flex-shrink-0" />
          <span className="text-muted-foreground font-medium">{displayType}</span>
          {toolName && (
            <span className="text-muted-foreground/50 ml-auto font-mono text-xs">{toolName}</span>
          )}
        </div>

        <div className="space-y-2.5 px-3 py-2.5">
          {validationIssues.map((issue, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-start gap-2">
                <CircleAlert className="text-muted-foreground/60 mt-0.5 size-3 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  {issue.path.length > 0 && (
                    <span className="bg-muted/60 text-muted-foreground/70 mr-1.5 rounded px-1.5 py-0.5 font-mono text-xs">
                      {issue.path.join('.')}
                    </span>
                  )}
                  <span className="text-foreground/80 text-xs">{issue.message}</span>
                </div>
              </div>

              {issue.values && issue.values.length > 0 && (
                <div className="ml-5">
                  <div className="text-muted-foreground/50 mb-1 text-xs">
                    {tHardcodedUi.raw(
                      'componentsSessionToolRenderers.line7845JsxTextExpectedOneOf',
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {issue.values.map((val, vi) => (
                      <span
                        key={vi}
                        className="bg-muted/40 text-muted-foreground/70 rounded-md px-1.5 py-0.5 font-mono text-xs"
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
      </div>
    );
  }

  return (
    <div className="overflow-hidden text-xs">
      <p className="text-muted-foreground/80 px-2 py-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {summary}
      </p>
      {traceback && (
        <>
          <button
            onClick={() => setShowTrace((v) => !v)}
            className="text-muted-foreground/50 hover:text-muted-foreground flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left transition-colors"
          >
            <ChevronRight className={cn('size-3 transition-transform', showTrace && 'rotate-90')} />
            <span className="text-xs font-medium">
              {tHardcodedUi.raw('componentsSessionToolRenderers.line7883JsxTextStackTrace')}
            </span>
          </button>
          {showTrace && (
            <div className="max-h-48 overflow-auto px-2 pb-2">
              <pre className="text-muted-foreground/50 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                {traceback}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

