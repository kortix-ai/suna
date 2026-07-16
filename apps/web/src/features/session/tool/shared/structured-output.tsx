'use client';

import { STATUS_BG, STATUS_BORDER, STATUS_TEXT } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import type { OutputSection } from '@/lib/utils/structured-output';
import { AlertTriangle, Ban, CheckCircle, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

export function StructuredOutput({ sections }: { sections: OutputSection[] }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [showTrace, setShowTrace] = useState(false);

  return (
    <div className="space-y-1.5 p-2.5">
      {sections.map((section, i) => {
        switch (section.type) {
          case 'warning':
            return (
              <div
                key={i}
                className={cn(
                  'flex items-start gap-2 rounded-2xl border px-2.5 py-1.5',
                  STATUS_BORDER.warning,
                  STATUS_BG.warning,
                )}
              >
                <AlertTriangle className={cn('mt-0.5 size-3 flex-shrink-0', STATUS_TEXT.warning)} />
                <p
                  className={cn(
                    'font-mono text-xs leading-relaxed break-words',
                    STATUS_TEXT.warning,
                  )}
                >
                  {section.text}
                </p>
              </div>
            );

          case 'error':
            return (
              <div
                key={i}
                className="bg-muted/40 border-border/60 flex items-start gap-2 rounded-2xl border px-2.5 py-1.5"
              >
                <Ban className="text-muted-foreground/70 mt-0.5 size-3 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  {section.errorType && (
                    <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                      {section.errorType}
                    </span>
                  )}
                  <p className="text-muted-foreground font-mono text-xs leading-relaxed break-words">
                    {section.summary}
                  </p>
                </div>
              </div>
            );

          case 'traceback':
            return (
              <div key={i}>
                <button
                  onClick={() => setShowTrace((v) => !v)}
                  className="text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors"
                >
                  <ChevronRight
                    className={cn(
                      'size-3 flex-shrink-0 transition-transform',
                      showTrace && 'rotate-90',
                    )}
                  />
                  <span className="text-xs font-medium">
                    {tHardcodedUi.raw('componentsSessionToolRenderers.line1597JsxTextStackTrace')}
                  </span>
                  <span className="text-muted-foreground/40 ml-1 font-mono text-xs">
                    {section.lines.length} lines
                  </span>
                </button>
                {showTrace && (
                  <div className="mt-1 overflow-hidden">
                    <pre className="text-muted-foreground/60 max-h-64 overflow-auto p-2.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                      {section.lines.map((line, li) => {
                        if (/^\s+File "/.test(line)) {
                          return (
                            <span key={li} className="text-muted-foreground/80">
                              {line}
                              {'\n'}
                            </span>
                          );
                        }
                        return (
                          <span key={li}>
                            {line}
                            {'\n'}
                          </span>
                        );
                      })}
                    </pre>
                  </div>
                )}
              </div>
            );

          case 'install':
            return (
              <div
                key={i}
                className={cn(
                  'flex items-center gap-2 rounded-2xl border px-2.5 py-1.5',
                  STATUS_BORDER.success,
                  STATUS_BG.success,
                )}
              >
                <CheckCircle className={cn('size-3 flex-shrink-0', STATUS_TEXT.success)} />
                <span className={cn('font-mono text-xs', STATUS_TEXT.success)}>{section.text}</span>
              </div>
            );

          case 'info':
            return (
              <div
                key={i}
                className="text-muted-foreground flex items-center gap-2 px-2.5 py-1 font-mono text-xs"
              >
                <span className="bg-muted-foreground/30 size-1 flex-shrink-0 rounded-full" />
                <span className="break-words">{section.text}</span>
              </div>
            );

          case 'plain':
            return (
              <pre
                key={i}
                className="text-foreground/70 px-2.5 py-1 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
              >
                {section.text}
              </pre>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}
