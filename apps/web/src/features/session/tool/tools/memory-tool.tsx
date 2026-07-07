'use client';

import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { DiffStat, STATUS_BG, STATUS_BORDER, STATUS_TEXT } from '@/components/ui/status';
import { Stepper, StepperItem, StepperSeparator, StepperTrigger } from '@/components/ui/stepper';
import {
  BasicTool,
  InlineDiffView,
  partInput,
  partOutput,
  partStatus,
  partStreamingInput,
  ToolCode,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { ToolError } from '@/features/session/tool/tool-error';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import {
  Brain,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  MessageCircle,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

import { memoryRelPath, parseMemoryView } from '@/features/session/tool/shared/memory-helpers';
import { formatRelative } from '@kortix/shared';

export function MemoryTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const { openPreview } = useFilePreviewStore();

  const command = (input.command as string) || (streamingInput.command as string) || '';
  const path =
    (input.path as string) ||
    (streamingInput.path as string) ||
    (input.old_path as string) ||
    (streamingInput.old_path as string) ||
    '';
  const oldPath = (input.old_path as string) || '';
  const newPath = (input.new_path as string) || '';
  const fileText = (input.file_text as string) || (streamingInput.file_text as string) || '';
  const oldStr = (input.old_str as string) ?? (streamingInput.old_str as string) ?? '';
  const newStr = (input.new_str as string) ?? (streamingInput.new_str as string) ?? '';
  const insertText = (input.insert_text as string) || (streamingInput.insert_text as string) || '';
  const insertLine = input.insert_line ?? streamingInput.insert_line;

  const relPath = memoryRelPath(path);
  const ext = (relPath.split('.').pop() || 'md').toLowerCase();
  const isFileTarget = command !== 'view' || /\.\w+$/.test(path);

  const failed =
    !!output &&
    (/^no replacement was performed/i.test(output.trim()) || /did not appear/i.test(output));

  const isStreaming = (status === 'pending' && running) || status === 'running';

  const view = useMemo(
    () => (command === 'view' ? parseMemoryView(output, path) : null),
    [command, output, path],
  );

  let body: ReactNode = null;
  if (command === 'view') {
    if (view?.type === 'dir') {
      body =
        view.entries.length > 0 ? (
          <FadedScrollArea fadeColor="from-background">
            <Stepper
              orientation="vertical"
              count={view.entries.length}
              className="flex w-full flex-col"
            >
              {view.entries.map((entry, i) => {
                const isLast = i + 1 >= view.entries.length;
                return (
                  <div key={entry.path} className="flex gap-2.5">
                    <StepperItem step={i + 1} completed className="items-center">
                      <StepperTrigger asChild>
                        <span className="flex shrink-0">
                          {entry.isDir ? (
                            <Folder className="text-muted-foreground/50 size-3.5" />
                          ) : (
                            <FileText className="text-muted-foreground/50 size-3.5" />
                          )}
                        </span>
                      </StepperTrigger>
                      <StepperSeparator className="bg-border m-0 my-0.5 group-data-[orientation=vertical]/stepper:min-h-2" />
                    </StepperItem>
                    <div
                      className={cn('flex min-w-0 flex-1 items-center gap-2', !isLast && 'pb-3')}
                    >
                      <span className="text-muted-foreground/80 truncate font-mono text-xs">
                        {memoryRelPath(entry.path)}
                      </span>
                      <span className="text-muted-foreground/40 ml-auto shrink-0 text-xs tabular-nums">
                        {entry.size}
                      </span>
                    </div>
                  </div>
                );
              })}
            </Stepper>
          </FadedScrollArea>
        ) : (
          <ToolEmptyState
            message={tI18nHardcoded.raw(
              'autoFeaturesSessionToolRenderersJsxAttrMessageMemoryIsEmptyc797bb83',
            )}
          />
        );
    } else if (view?.type === 'file' && view.content) {
      body = <ToolCode code={view.content} language={ext} />;
    } else if (output) {
      body = <ToolOutputFallback output={output} toolName="memory" />;
    } else {
      body = <ToolEmptyState message={isStreaming ? 'Reading memory…' : 'Nothing to show.'} />;
    }
  } else if (command === 'create') {
    body = fileText ? (
      <ToolCode code={fileText} language={ext} />
    ) : (
      <ToolEmptyState message={isStreaming ? 'Writing memory…' : 'No content.'} />
    );
  } else if (command === 'str_replace') {
    body = failed ? (
      <ToolError error={output} toolName="memory" />
    ) : oldStr || newStr ? (
      <div data-scrollable className="max-h-96 overflow-auto">
        <InlineDiffView oldValue={oldStr} newValue={newStr} filename={relPath} />
      </div>
    ) : (
      <ToolEmptyState
        message={tI18nHardcoded.raw(
          'autoFeaturesSessionToolRenderersJsxAttrMessageNoChanges0aa33a4a',
        )}
      />
    );
  } else if (command === 'insert') {
    body = (
      <>
        {insertLine != null && (
          <div className="text-muted-foreground/70 px-3 pt-2 text-xs">
            {tI18nHardcoded.raw('autoFeaturesSessionToolRenderersJsxTextInsertedAtLine1bc36059')}
            {String(insertLine)}
          </div>
        )}
        {insertText ? <ToolCode code={insertText} language={ext} /> : null}
        {!insertText && insertLine == null ? (
          <ToolEmptyState
            message={tI18nHardcoded.raw(
              'autoFeaturesSessionToolRenderersJsxAttrMessageNothingInsertede2d2969f',
            )}
          />
        ) : null}
      </>
    );
  } else if (command === 'rename') {
    body = (
      <div className="text-muted-foreground/80 flex flex-wrap items-center gap-1.5 px-3 py-2 font-mono text-xs">
        <span className="truncate">{memoryRelPath(oldPath || path)}</span>
        <ChevronRight className="text-muted-foreground/40 size-3 flex-shrink-0" />
        <span className="text-foreground/80 truncate">{memoryRelPath(newPath)}</span>
      </div>
    );
  } else if (command === 'delete') {
    body = (
      <div className="text-muted-foreground/70 flex items-center gap-1.5 px-3 py-2 text-xs">
        <Trash2 className="size-3 flex-shrink-0" />
        <span className="truncate font-mono">{relPath}</span>
      </div>
    );
  } else if (output) {
    body = <ToolOutputFallback output={output} toolName="memory" />;
  }

  return (
    <BasicTool
      icon={<Brain className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Memory',
        // subtitle: command === 'rename' ? memoryRelPath(newPath) : relPath,
      }}
      onSubtitleClick={
        path && isFileTarget && command !== 'delete' ? () => openPreview(path) : undefined
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {body}
    </BasicTool>
  );
}
ToolRegistry.register('memory', MemoryTool);
ToolRegistry.register('oc-memory', MemoryTool);

function formatBashOutput(rawOutput: string): {
  content: string;
  lang: string;
} {
  const trimmed = rawOutput.trim();
  if (!trimmed) return { content: '', lang: 'bash' };

  try {
    const parsed = JSON.parse(trimmed);
    return { content: JSON.stringify(parsed, null, 2), lang: 'json' };
  } catch {}

  if (trimmed.includes('===') && trimmed.includes('{')) {
    const sections = trimmed.split(/^(={2,}\s.*)/m);
    let hasJson = false;
    const formatted = sections
      .map((section) => {
        const st = section.trim();
        if (!st) return '';
        if (/^={2,}\s/.test(st)) return st;
        try {
          const parsed = JSON.parse(st);
          hasJson = true;
          return JSON.stringify(parsed, null, 2);
        } catch {
          return st;
        }
      })
      .filter(Boolean)
      .join('\n\n');
    if (hasJson) return { content: formatted, lang: 'json' };
  }

  return { content: trimmed, lang: 'bash' };
}

interface ParsedSessionMeta {
  id: string;
  slug?: string;
  title: string;
  directory?: string;
  time: { created: number; updated: number };
  summary?: { additions: number; deletions: number; files: number };
  filePath?: string;
}

function parseSessionMetadataOutput(output: string): ParsedSessionMeta[] | null {
  const trimmed = output.trim();
  if (!trimmed.includes('===') || !trimmed.includes('"id"')) return null;

  const parts = trimmed.split(/^={2,}\s*(.*?)\s*={0,}\s*$/m);
  const sessions: ParsedSessionMeta[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;

    try {
      const parsed = JSON.parse(part);
      if (parsed && typeof parsed === 'object' && parsed.id && parsed.time) {
        const header = i > 0 ? parts[i - 1]?.trim() : undefined;
        sessions.push({
          id: parsed.id,
          slug: parsed.slug,
          title: parsed.title || parsed.slug || 'Untitled',
          directory: parsed.directory,
          time: parsed.time,
          summary: parsed.summary,
          filePath: header || undefined,
        });
      }
    } catch {}
  }

  if (sessions.length === 0) return null;
  return sessions;
}

// Deterministic UTC date for the first (server) render, so hydration matches;
// the client effect below swaps it for a live relative label after mount.
const stableDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function SessionTimeLabel({ timestamp }: { timestamp: number }) {
  const [label, setLabel] = useState(() => stableDate.format(new Date(timestamp)));

  useEffect(() => {
    const update = () =>
      setLabel(
        formatRelative(timestamp, {
          maxRelativeDays: 7,
          dateFallback: { month: 'short', day: 'numeric' },
        }) ?? '',
      );
    update();
    const intervalId = window.setInterval(update, 60_000);
    return () => window.clearInterval(intervalId);
  }, [timestamp]);

  return <span suppressHydrationWarning>{label}</span>;
}

function SessionMetadataList({ sessions }: { sessions: ParsedSessionMeta[] }) {
  const { enabled: navigationEnabled, openTab } = useToolNavigation();

  return (
    <div className="flex flex-col gap-1 p-1.5">
      <div className="text-muted-foreground px-1.5 py-1 text-xs font-medium tracking-wider uppercase">
        {sessions.length} session{sessions.length !== 1 ? 's' : ''}
      </div>
      {sessions.map((s) => (
        <button
          key={s.id}
          disabled={!navigationEnabled}
          onClick={() =>
            openTab({
              id: s.id,
              title: s.title || 'Session',
              type: 'session',
              href: `/sessions/${s.id}`,
            })
          }
          className={cn(
            'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left',
            navigationEnabled
              ? 'hover:bg-muted/60 group cursor-pointer transition-colors'
              : 'group cursor-default opacity-70 transition-colors',
          )}
        >
          <MessageCircle className="text-muted-foreground group-hover:text-foreground/60 mt-0.5 size-3.5 flex-shrink-0 transition-colors" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-foreground truncate text-xs font-medium">{s.title}</span>
              {s.summary && s.summary.files > 0 && (
                <span className="flex flex-shrink-0 items-center gap-1.5 text-xs">
                  <DiffStat additions={s.summary.additions} deletions={s.summary.deletions} />
                  <span className="text-muted-foreground">
                    {s.summary.files} file{s.summary.files !== 1 ? 's' : ''}
                  </span>
                </span>
              )}
            </div>
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="truncate font-mono">{s.slug || s.id}</span>
              <span className="flex-shrink-0">
                <SessionTimeLabel timestamp={s.time.updated} />
              </span>
            </div>
          </div>
          <ExternalLink className="text-muted-foreground/0 group-hover:text-muted-foreground mt-1 size-3 flex-shrink-0 transition-colors" />
        </button>
      ))}
    </div>
  );
}

interface ParsedSessionMessage {
  index: number;
  role: string;
  cost: number;
  content: string;
  tools?: string;
}

function parseSessionMessagesOutput(output: string): ParsedSessionMessage[] | null {
  const trimmed = output.trim();
  if (!trimmed.includes('--- Msg ')) return null;

  const msgRegex = /---\s*Msg\s+(\d+)\s+\[(\w+)\]\s+cost=\$?([\d.]+)\s*---/g;
  const matches = [...trimmed.matchAll(msgRegex)];
  if (matches.length < 1) return null;

  const messages: ParsedSessionMessage[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : trimmed.length;
    const rawContent = trimmed.slice(start, end).trim();

    const toolsMatch = rawContent.match(/^\s*Tools used:\s*(.+)$/m);
    const content = rawContent.replace(/^\s*Tools used:\s*.+$/m, '').trim();

    messages.push({
      index: parseInt(m[1], 10),
      role: m[2].toLowerCase(),
      cost: parseFloat(m[3]),
      content,
      tools: toolsMatch?.[1],
    });
  }

  return messages.length > 0 ? messages : null;
}

function InlineSessionMessagesList({ messages }: { messages: ParsedSessionMessage[] }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex flex-col gap-1 p-1.5">
      <div className="text-muted-foreground px-1.5 py-1 text-xs font-medium tracking-wider uppercase">
        {messages.length} message{messages.length !== 1 ? 's' : ''}
      </div>
      {messages.map((msg) => (
        <div
          key={msg.index}
          className={cn(
            'overflow-hidden rounded-2xl border',
            msg.role === 'user' ? 'border-border/60' : 'border-border/40',
          )}
        >
          <div
            className={cn(
              'flex items-center gap-2 px-2.5 py-1',
              msg.role === 'user' ? 'bg-muted/50' : 'bg-card',
            )}
          >
            <span
              className={cn(
                'text-xs font-semibold tracking-wide uppercase',
                msg.role === 'user' ? STATUS_TEXT.info : STATUS_TEXT.success,
              )}
            >
              {msg.role}
            </span>
            <span className="text-muted-foreground/50 ml-auto text-xs">#{msg.index}</span>
            {msg.cost > 0 && (
              <span className="text-muted-foreground/50 text-xs">
                ${(msg.cost * 1.2).toFixed(4)}
              </span>
            )}
          </div>
          <div className="px-2.5 py-1.5">
            <div className="text-foreground/90 text-xs leading-relaxed break-words whitespace-pre-wrap">
              {msg.content.slice(0, 800)}
              {msg.content.length > 800 && (
                <span className="text-muted-foreground/50">
                  {' '}
                  {tHardcodedUi.raw('componentsSessionToolRenderers.line2350JsxTextTruncated')}
                </span>
              )}
            </div>
            {msg.tools && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {msg.tools.split(',').map((t, i) => {
                  const trimmedTool = t.trim();
                  const nameMatch = trimmedTool.match(/^(\w+)\s*\((\w+)\)/);
                  const name = nameMatch?.[1] || trimmedTool;
                  const toolStatus = nameMatch?.[2] || '';
                  return (
                    <span
                      key={i}
                      className={cn(
                        'rounded border px-1 py-0.5 text-xs',
                        toolStatus === 'completed'
                          ? cn(STATUS_BG.success, STATUS_BORDER.success, STATUS_TEXT.success)
                          : 'bg-muted/50 border-border/50 text-muted-foreground',
                      )}
                    >
                      {name}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
