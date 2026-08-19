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
import {
  FoldedSection,
  OutputBlock,
  ToolField,
  ToolSection,
} from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { parseMemoryEntryOutput } from '@/lib/utils/memory-entry-output';
import {
  BrainIcon as Brain,
  CalendarDotsIcon as CalendarClock,
  FingerprintIcon as Fingerprint,
} from '@phosphor-icons/react';
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

  // What the row says when it is SHUT.
  //
  // It used to say `Recalled · #482`, and a group of them said `Recalled ·
  // #482` / `Recalled · #1180` — two rows that name neither the memory nor
  // anything a reader could act on. The payload already carries the words: an
  // observation has a `title`, an LTM entry a `caption`. Those go in the
  // subtitle; the id, which identifies the record but not the memory, moves to
  // the badge at the row's right edge. Until the output parses (streaming, or
  // an unrecognized shape) the id is all there is, so it stays the subtitle
  // rather than leaving the row with nothing.
  const recalled = report ? (report.kind === 'observation' ? report.title : report.caption) : '';
  const idLabel = memoryId ? `#${memoryId}` : undefined;

  return (
    <BasicTool
      icon={<Brain className="size-3.5 shrink-0" />}
      trigger={{
        title: 'Recalled',
        subtitle: recalled || idLabel,
      }}
      badge={recalled ? idLabel : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {report ? (
        // Shared result card, not a bespoke muted div — holds composed fields.
        //
        // What a reader opened a recalled memory for is the memory: an
        // observation's title and narrative, an entry's caption and content.
        // Everything else here — which call asked for it, which facts and
        // concepts were extracted, which files it touched, its tags — is
        // provenance, and it used to stack open underneath the answer as six
        // more labelled sections. Those fold; the answer does not.
        <ToolResultCard bodyClassName="space-y-2.5 p-2">
          {(source || memoryId) && (
            <FoldedSection label="Request">
              <div className="flex flex-wrap items-center gap-1.5">
                {source && <ToolField label="Source" value={source} />}
                {memoryId && <ToolField label="ID" value={`#${memoryId}`} mono />}
              </div>
            </FoldedSection>
          )}

          {/* One meta line, one baseline. Each span is `inline-flex
              items-center`: without it the icon claimed its own line box, so
              the fingerprint sat ABOVE `Observation #482` and the uppercase
              type label beside it rode visibly higher than the id it
              qualifies. The created date lost its `ml-auto` for the same
              reason it needed fixing — in a `flex-wrap` row `ml-auto` pushes a
              wrapped item to the far right and leaves the gap it came from
              dead. It reads as the third fact on the line instead. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <Fingerprint className="size-3 shrink-0" />
              <span>
                {report.kind === 'observation'
                  ? tHardcodedUi.raw('componentsSessionToolRenderers.line1730JsxTextObservation')
                  : tHardcodedUi.raw('componentsSessionToolRenderers.line1847JsxTextLTM')}
                {report.id}
              </span>
            </span>
            <span className="text-muted-foreground inline-flex items-center text-xs tracking-wide uppercase">
              {report.type}
            </span>
            {report.created && (
              <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                <CalendarClock className="size-3 shrink-0" />
                <span>{report.created}</span>
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
                <FoldedSection label={`Facts (${report.facts.length})`}>
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
                </FoldedSection>
              )}
              {report.concepts.length > 0 && (
                <FoldedSection label="Concepts">
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
                </FoldedSection>
              )}
              {(report.tool || report.prompt || report.session || report.filesRead.length > 0) && (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {report.tool && <ToolField label="Tool" value={report.tool} />}
                    {/* NOT a `ToolField`. The token is "Prompt #" / "Prompt
                        n°" — a word plus the marker for the number that
                        follows it — and `ToolField` puts a `gap-2` between its
                        label and its value, which rendered `Prompt # 14`. The
                        marker belongs to the number, so the two are set
                        adjacent, exactly as the `Observation #482` line above
                        sets them, and the token stays whole for every locale. */}
                    {report.prompt && (
                      <span className="text-muted-foreground/60 inline-flex items-baseline text-xs">
                        {tHardcodedUi.raw('componentsSessionToolRenderers.line1811JsxTextPrompt')}
                        <span className="text-foreground/80">{report.prompt}</span>
                      </span>
                    )}
                    {report.session && <ToolField label="Session" value={report.session} mono />}
                  </div>
                  {report.filesRead.length > 0 && (
                    <FoldedSection
                      label={`${tHardcodedUi.raw(
                        'componentsSessionToolRenderers.line1823JsxTextFilesRead',
                      )} (${report.filesRead.length})`}
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
                    </FoldedSection>
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
                <FoldedSection label={`Tags (${report.tags.length})`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {report.tags.map((tag) => (
                      <span key={tag} className={cn('text-xs font-medium', STATUS_TEXT.success)}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </FoldedSection>
              )}
              {(report.session || report.updated) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {report.session && <ToolField label="Session" value={report.session} mono />}
                  {report.updated && <ToolField label="Updated" value={report.updated} />}
                </div>
              )}
            </>
          )}
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="get_mem" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Loading memory...' : 'No memory found.'} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('get_mem', GetMemTool);
ToolRegistry.register('get-mem', GetMemTool);
ToolRegistry.register('oc-get_mem', GetMemTool);
ToolRegistry.register('oc-get-mem', GetMemTool);
