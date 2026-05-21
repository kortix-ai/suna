'use client';

import React, { useMemo } from 'react';
import { Terminal, AlertCircle, Clock, MessageCircle, ExternalLink } from 'lucide-react';
import { ToolViewProps } from '../types';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useServerStore } from '@/stores/server-store';
import { LoadingState } from '../shared/LoadingState';
import { PreWithPaths } from '@/components/common/clickable-path';
import { formatTimestamp } from '../utils';
import { cn } from '@/lib/utils';
import {
  CodeBlock,
  Counter,
  Status,
  ToolViewBody,
  ToolViewFoot,
  ToolViewHead,
  ToolViewLabel,
  ToolViewShell,
} from '../shared/primitives';

// ── Output massaging ────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

interface BashMeta {
  message: string;
  isTimeout: boolean;
  timeoutMs: number | null;
}

function extractMetadata(output: string): { cleanOutput: string; metadata: BashMeta[] } {
  const metadata: BashMeta[] = [];
  const cleanOutput = output
    .replace(/<bash_metadata>([\s\S]*?)<\/bash_metadata>/g, (_, content) => {
      const msg = content.trim();
      const timeoutMatch = msg.match(/timeout\s+(\d+)\s*ms/i);
      metadata.push({
        message: msg,
        isTimeout: /timeout|timed?\s*out/i.test(msg),
        timeoutMs: timeoutMatch ? parseInt(timeoutMatch[1], 10) : null,
      });
      return '';
    })
    .replace(/<\/?(?:system_info|exit_code|stderr_note)>[\s\S]*?(?:<\/\w+>|$)/g, '')
    .trim();
  return { cleanOutput, metadata };
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function detectLang(text: string): { content: string; lang: 'json' | 'bash' } {
  const trimmed = text.trim();
  if (!trimmed) return { content: '', lang: 'bash' };
  try {
    const parsed = JSON.parse(trimmed);
    return { content: JSON.stringify(parsed, null, 2), lang: 'json' };
  } catch {
    return { content: trimmed, lang: 'bash' };
  }
}

// ── Optional rich output parsers (session list / messages) ───────────────────

interface ParsedSession {
  id: string;
  slug?: string;
  title: string;
  time: { created: number; updated: number };
  summary?: { additions: number; deletions: number; files: number };
}

function parseSessionMetadata(output: string): ParsedSession[] | null {
  const trimmed = output.trim();
  if (!trimmed.includes('===') || !trimmed.includes('"id"')) return null;
  const parts = trimmed.split(/^={2,}\s*(.*?)\s*={0,}\s*$/m);
  const sessions: ParsedSession[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed?.id && parsed?.time) {
        sessions.push({
          id: parsed.id,
          slug: parsed.slug,
          title: parsed.title || parsed.slug || 'Untitled',
          time: parsed.time,
          summary: parsed.summary,
        });
      }
    } catch { /* skip non-JSON */ }
  }
  return sessions.length ? sessions : null;
}

function sessionAge(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function SessionList({ sessions }: { sessions: ParsedSession[] }) {
  return (
    <div className="-mx-1 divide-y divide-border/40">
      {sessions.map((s) => (
        <button
          key={s.id}
          onClick={() =>
            openTabAndNavigate({
              id: s.id,
              title: s.title || 'Session',
              type: 'session',
              href: `/sessions/${s.id}`,
              serverId: useServerStore.getState().activeServerId,
            })
          }
          className="group flex items-center gap-3 px-1 py-2 w-full text-left hover:bg-foreground/[0.025] transition-colors cursor-pointer"
        >
          <MessageCircle className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/60 group-hover:text-foreground/80 transition-colors" />
          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
            <span className="text-[12.5px] font-medium tracking-tight truncate">{s.title}</span>
            <span className="text-[11px] text-muted-foreground/60 font-mono truncate">
              {s.slug || s.id}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70 tracking-tight flex-shrink-0">
            {s.summary && s.summary.files > 0 && (
              <span className="font-mono tabular-nums">
                {s.summary.files} {s.summary.files === 1 ? 'file' : 'files'}
              </span>
            )}
            <span className="tabular-nums">{sessionAge(s.time.updated)}</span>
          </div>
          <ExternalLink className="w-3 h-3 flex-shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground/70 transition-colors" />
        </button>
      ))}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function OcBashToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const command = (args.command as string) || '';
  const description = (args.description as string) || '';
  const ocState = args._oc_state as any;

  const rawOutput =
    toolResult?.output ||
    (ocState?.status === 'running' && ocState?.metadata?.output) ||
    '';
  const stripped = typeof rawOutput === 'string' ? stripAnsi(rawOutput) : '';

  const { cleanOutput, metadata } = useMemo(() => extractMetadata(stripped), [stripped]);
  const isError = toolResult?.success === false || !!toolResult?.error;
  const hasTimeout = metadata.some((m) => m.isTimeout);

  const sessionMeta = useMemo(() => parseSessionMetadata(cleanOutput), [cleanOutput]);

  const output = useMemo(() => {
    if (!cleanOutput || sessionMeta) return null;
    return detectLang(cleanOutput);
  }, [cleanOutput, sessionMeta]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Running command" subtitle={description || command} />;
  }

  const ts = toolTimestamp && !isStreaming
    ? formatTimestamp(toolTimestamp)
    : assistantTimestamp ? formatTimestamp(assistantTimestamp) : undefined;

  return (
    <ToolViewShell>
      <ToolViewHead
        icon={Terminal}
        title={description || 'Shell'}
        detail={command.length > 80 ? command.slice(0, 80) + '…' : command}
      />

      <ToolViewBody>
        <div className="flex flex-col gap-4">
          {/* Command */}
          <section className="flex flex-col gap-1.5">
            <ToolViewLabel>Command</ToolViewLabel>
            <CodeBlock lang="bash">
              <span className="text-muted-foreground/50 select-none">$ </span>
              {command}
            </CodeBlock>
          </section>

          {/* Output */}
          {sessionMeta ? (
            <section className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <ToolViewLabel>Sessions</ToolViewLabel>
                <Counter value={sessionMeta.length} label={sessionMeta.length === 1 ? 'session' : 'sessions'} />
              </div>
              <SessionList sessions={sessionMeta} />
            </section>
          ) : output && output.content ? (
            <section className="flex flex-col gap-1.5">
              <ToolViewLabel>Output</ToolViewLabel>
              {output.lang === 'json' ? (
                <CodeBlock lang="json">{output.content}</CodeBlock>
              ) : (
                <div className="rounded-2xl border border-border/50 bg-foreground/[0.025] overflow-hidden">
                  <PreWithPaths
                    text={output.content}
                    className="p-3 font-mono text-[12px] leading-relaxed text-foreground/85 whitespace-pre-wrap break-words overflow-x-auto"
                  />
                </div>
              )}
            </section>
          ) : null}

          {/* Metadata notes */}
          {metadata.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {metadata.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-2 px-3 py-2 rounded-2xl border text-[11.5px] tracking-tight',
                    m.isTimeout
                      ? 'border-red-500/25 bg-red-500/[0.04] text-red-500/90'
                      : 'border-border/50 bg-foreground/[0.02] text-muted-foreground/80',
                  )}
                >
                  {m.isTimeout ? <Clock className="w-3 h-3 flex-shrink-0 mt-0.5" /> : null}
                  <span className="leading-relaxed flex-1">
                    {m.isTimeout && m.timeoutMs
                      ? `Command timed out after ${formatDuration(m.timeoutMs)}`
                      : m.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </ToolViewBody>

      <ToolViewFoot timestamp={ts}>
        {isError ? (
          <Status tone="error">
            <AlertCircle className="w-3 h-3" />
            Failed
          </Status>
        ) : hasTimeout ? (
          <Status tone="warn">
            <Clock className="w-3 h-3" />
            Timed out
          </Status>
        ) : (
          <Status tone="success">Completed</Status>
        )}
      </ToolViewFoot>
    </ToolViewShell>
  );
}
