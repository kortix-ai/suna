'use client';

import { STATUS_TEXT, StatusDot } from '@/components/ui/status';
import {
  BasicTool,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock, ToolField, ToolSection } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { parseMemoryEntryOutput } from '@/lib/utils/memory-entry-output';
import { Brain, CalendarClock, Fingerprint } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useContext, useMemo } from 'react';

export function GetMemTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const source = (input.source as string) || '';
  const memoryId = input.id != null ? String(input.id) : '';
  const report = useMemo(() => parseMemoryEntryOutput(output), [output]);
  const isStreaming = (status === 'pending' && running) || status === 'running';

  return (
    <BasicTool
      icon={<Brain className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Get Mem',
        subtitle: memoryId ? `#${memoryId}` : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="space-y-2.5 p-2.5">
        {(source || memoryId) && (
          <ToolSection label="Request">
            <div className="flex flex-wrap items-center gap-1.5">
              {source && <ToolField label="Source" value={source} />}
              {memoryId && <ToolField label="ID" value={`#${memoryId}`} mono />}
            </div>
          </ToolSection>
        )}

        {report ? (
          // Card wrapper, not OutputBlock — holds composed fields, not output text.
          <div className="bg-muted/20 space-y-2.5 rounded-sm px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground text-xs">
                <Fingerprint className="size-3" />
                {report.kind === 'observation'
                  ? tHardcodedUi.raw('componentsSessionToolRenderers.line1730JsxTextObservation')
                  : tHardcodedUi.raw('componentsSessionToolRenderers.line1847JsxTextLTM')}
                {report.id}
              </span>
              <span className="text-muted-foreground text-xs tracking-wide uppercase">
                {report.type}
              </span>
              {report.created && (
                <span className="text-muted-foreground ml-auto text-xs">
                  <CalendarClock className="size-3" />
                  {report.created}
                </span>
              )}
            </div>

            {report.kind === 'observation' ? (
              <>
                {report.title && (
                  <h3 className="text-foreground/90 text-xs font-medium">{report.title}</h3>
                )}
                {report.narrative && (
                  <ToolSection label="Narrative">
                    <OutputBlock text={report.narrative} markdown />
                  </ToolSection>
                )}
                {report.facts.length > 0 && (
                  <ToolSection label={`Facts (${report.facts.length})`}>
                    <ul className="space-y-1">
                      {report.facts.map((fact, index) => (
                        <li
                          key={`${report.id}-${index}`}
                          className="text-foreground/90 flex items-start gap-1.5 text-xs leading-relaxed"
                        >
                          <StatusDot tone="success" className="mt-[6px]" />
                          <span>{fact}</span>
                        </li>
                      ))}
                    </ul>
                  </ToolSection>
                )}
                {report.concepts.length > 0 && (
                  <ToolSection label="Concepts">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {report.concepts.map((concept) => (
                        <span
                          key={concept}
                          className={cn('text-xs font-medium', STATUS_TEXT.success)}
                        >
                          {concept}
                        </span>
                      ))}
                    </div>
                  </ToolSection>
                )}
                {(report.tool ||
                  report.prompt ||
                  report.session ||
                  report.filesRead.length > 0) && (
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {report.tool && <ToolField label="Tool" value={report.tool} />}
                      {report.prompt && (
                        <ToolField
                          label={tHardcodedUi.raw(
                            'componentsSessionToolRenderers.line1811JsxTextPrompt',
                          )}
                          value={report.prompt}
                        />
                      )}
                      {report.session && (
                        <ToolField label="Session" value={report.session} mono />
                      )}
                    </div>
                    {report.filesRead.length > 0 && (
                      <ToolSection
                        label={tHardcodedUi.raw(
                          'componentsSessionToolRenderers.line1823JsxTextFilesRead',
                        )}
                      >
                        <div className="flex flex-wrap gap-1.5">
                          {report.filesRead.map((file) => (
                            <span
                              key={file}
                              className="bg-background border-border/70 text-foreground/75 inline-flex h-6 items-center rounded-sm border px-2 font-mono text-xs break-all"
                            >
                              {file}
                            </span>
                          ))}
                        </div>
                      </ToolSection>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                {report.caption && (
                  <ToolSection label="Caption">
                    <OutputBlock text={report.caption} markdown />
                  </ToolSection>
                )}
                {report.content && (
                  <ToolSection label="Content">
                    <OutputBlock text={report.content} markdown />
                  </ToolSection>
                )}
                {report.tags.length > 0 && (
                  <ToolSection label="Tags">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {report.tags.map((tag) => (
                        <span key={tag} className={cn('text-xs font-medium', STATUS_TEXT.success)}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </ToolSection>
                )}
                {(report.session || report.updated) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {report.session && <ToolField label="Session" value={report.session} mono />}
                    {report.updated && <ToolField label="Updated" value={report.updated} />}
                  </div>
                )}
              </>
            )}
          </div>
        ) : output ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="get_mem" />
        ) : (
          <ToolEmptyState message={isStreaming ? 'Loading memory...' : 'No memory found.'} />
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('get_mem', GetMemTool);
ToolRegistry.register('get-mem', GetMemTool);
ToolRegistry.register('oc-get_mem', GetMemTool);
ToolRegistry.register('oc-get-mem', GetMemTool);
