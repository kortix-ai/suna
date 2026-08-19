'use client';

import { STATUS_BG, STATUS_BORDER, STATUS_TEXT } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import type { OutputSection } from '@/lib/utils/structured-output';
import {
  ProhibitIcon as Ban,
  CheckCircleIcon as CheckCircle,
  CaretRightIcon as ChevronRight,
  WarningIcon,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

function sectionContent(section: OutputSection): string {
  switch (section.type) {
    case 'error':
      return `${section.errorType ?? ''}:${section.summary}`;
    case 'traceback':
      return section.lines.join('\n');
    default:
      return section.text;
  }
}

export function StructuredOutput({ sections }: { sections: OutputSection[] }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [showTrace, setShowTrace] = useState(false);

  const seen = new Map<string, number>();
  const keyed = sections.map((section) => {
    const base = `${section.type}:${sectionContent(section).slice(0, 80)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { section, key: n ? `${base}#${n}` : base };
  });

  return (
    <div className="space-y-1.5 p-2.5">
      {keyed.map(({ section, key }) => {
        switch (section.type) {
          case 'warning':
            return (
              <div
                key={key}
                className={cn(
                  'flex items-start gap-2 rounded-md border px-2.5 py-1.5',
                  STATUS_BORDER.warning,
                  STATUS_BG.warning,
                )}
              >
                <WarningIcon className={cn('mt-0.5 size-4 shrink-0', STATUS_TEXT.warning)} />
                <p
                  className={cn(
                    'font-mono text-xs leading-relaxed wrap-break-word',
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
                key={key}
                className="bg-muted/40 border-border/60 flex items-start gap-2 rounded-2xl border px-2.5 py-1.5"
              >
                <Ban className="text-muted-foreground/70 mt-0.5 size-3 shrink-0" />
                <div className="min-w-0 flex-1">
                  {section.errorType && (
                    <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                      {section.errorType}
                    </span>
                  )}
                  <p className="text-muted-foreground font-mono text-xs leading-relaxed wrap-break-word">
                    {section.summary}
                  </p>
                </div>
              </div>
            );

          case 'traceback':
            return (
              <div key={key}>
                <button
                  onClick={() => setShowTrace((v) => !v)}
                  className="text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors"
                >
                  <ChevronRight
                    className={cn(
                      'size-3 shrink-0 transition-transform',
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
                key={key}
                className={cn(
                  'flex items-center gap-2 rounded-2xl border px-2.5 py-1.5',
                  STATUS_BORDER.success,
                  STATUS_BG.success,
                )}
              >
                <CheckCircle className={cn('size-3 shrink-0', STATUS_TEXT.success)} />
                <span className={cn('font-mono text-xs', STATUS_TEXT.success)}>{section.text}</span>
              </div>
            );

          case 'info':
            return (
              <div
                key={key}
                className="text-muted-foreground flex items-center gap-2 px-2.5 py-1 font-mono text-xs"
              >
                <span className="bg-muted-foreground/30 size-1 shrink-0 rounded-full" />
                <span className="wrap-break-word">{section.text}</span>
              </div>
            );

          case 'plain':
            return (
              <pre
                key={key}
                className="text-foreground/70 px-2.5 py-1 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap"
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
