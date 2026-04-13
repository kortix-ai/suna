'use client';

import React, { useMemo } from 'react';
import {
  CheckCircle,
  AlertCircle,
  Zap,
  Clock,
  Webhook,
  Calendar,
  Trash2,
  List,
  Plus,
  Play,
  Pause,
  Settings,
  RotateCw,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';

// ── Parsing utilities ────────────────────────────────────────────────────────

interface ParsedTrigger {
  status: 'active' | 'paused' | 'unknown';
  name: string;
  sourceType: 'webhook' | 'cron' | 'unknown';
  /** e.g. "POST /hooks/github-pr" or "0 0 6 * * * (Daily at 06:00)" */
  sourceDetail: string;
  actionType: string;
  agent: string;
  lastRun: string;
}

interface ParsedCreateResult {
  name: string;
  id: string;
  trigger: ParsedTrigger | null;
}

function parseTriggerLine(line: string): ParsedTrigger | null {
  // [active] name | webhook: POST /path | prompt → agent | last_run: never
  // [active] name | cron: 0 0 6 * * * (Daily at 06:00) | prompt → agent | last_run: 2026-04-12T06:00:00.030Z
  const m = line.match(
    /^\[(\w+)]\s+(\S+)\s*\|\s*(webhook|cron):\s*(.+?)\s*\|\s*(\w+)\s*→\s*(\w+)\s*\|\s*last_run:\s*(.+)$/
  );
  if (!m) return null;
  return {
    status: m[1] as ParsedTrigger['status'],
    name: m[2],
    sourceType: m[3] as ParsedTrigger['sourceType'],
    sourceDetail: m[4].trim(),
    actionType: m[5],
    agent: m[6],
    lastRun: m[7].trim(),
  };
}

function parseListOutput(output: string): { count: number; triggers: ParsedTrigger[] } {
  const triggers: ParsedTrigger[] = [];
  const countMatch = output.match(/TRIGGERS\s*\((\d+)\)/);
  for (const line of output.split('\n')) {
    const t = parseTriggerLine(line.trim());
    if (t) triggers.push(t);
  }
  return { count: countMatch ? parseInt(countMatch[1], 10) : triggers.length, triggers };
}

function parseCreateOutput(output: string): ParsedCreateResult | null {
  // "Trigger created: name (uuid)\n[active] name | ..."
  const headerMatch = output.match(/Trigger created:\s*(\S+)\s*\(([^)]+)\)/);
  if (!headerMatch) return null;
  const lines = output.split('\n');
  let trigger: ParsedTrigger | null = null;
  for (const l of lines) {
    const t = parseTriggerLine(l.trim());
    if (t) { trigger = t; break; }
  }
  return { name: headerMatch[1], id: headerMatch[2], trigger };
}

function formatLastRun(lastRun: string): string {
  if (lastRun === 'never') return 'Never';
  try {
    return new Date(lastRun).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return lastRun; }
}

// ── Action config ────────────────────────────────────────────────────────────

type TriggerAction = 'create' | 'list' | 'get' | 'delete' | 'update' | 'test' | 'pause' | 'resume';

const actionMeta: Record<TriggerAction, { icon: typeof Zap; label: string; loadingLabel: string }> = {
  create: { icon: Plus, label: 'Trigger Created', loadingLabel: 'Creating trigger...' },
  list:   { icon: List, label: 'Triggers', loadingLabel: 'Listing triggers...' },
  get:    { icon: Settings, label: 'Trigger Details', loadingLabel: 'Fetching trigger...' },
  delete: { icon: Trash2, label: 'Trigger Deleted', loadingLabel: 'Deleting trigger...' },
  update: { icon: Settings, label: 'Trigger Updated', loadingLabel: 'Updating trigger...' },
  test:   { icon: Play, label: 'Trigger Tested', loadingLabel: 'Testing trigger...' },
  pause:  { icon: Pause, label: 'Trigger Paused', loadingLabel: 'Pausing trigger...' },
  resume: { icon: RotateCw, label: 'Trigger Resumed', loadingLabel: 'Resuming trigger...' },
};

// ── Sub-renderers ────────────────────────────────────────────────────────────

function TriggerCard({ t }: { t: ParsedTrigger }) {
  const SourceIcon = t.sourceType === 'webhook' ? Webhook : Calendar;
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-border/50 bg-card">
      <div className="p-2 rounded-lg bg-muted">
        <SourceIcon className="size-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{t.name}</div>
        <div className="text-xs text-muted-foreground truncate">
          {t.sourceType === 'webhook' ? t.sourceDetail : `cron: ${t.sourceDetail}`}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {t.lastRun !== 'never' && (
          <span className="text-[10px] text-muted-foreground/70 hidden sm:inline">
            Last: {formatLastRun(t.lastRun)}
          </span>
        )}
        <Badge
          variant="outline"
          className={`h-5 text-[10px] py-0 ${
            t.status === 'active'
              ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
              : t.status === 'paused'
                ? 'border-amber-500/40 text-amber-600 dark:text-amber-400'
                : ''
          }`}
        >
          {t.status}
        </Badge>
      </div>
    </div>
  );
}

function ListContent({ output }: { output: string }) {
  const { count, triggers } = useMemo(() => parseListOutput(output), [output]);

  if (triggers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12 px-6">
        <Zap className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No triggers configured</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="p-4 space-y-2">
        <div className="text-xs text-muted-foreground mb-2">{count} trigger{count !== 1 ? 's' : ''}</div>
        {triggers.map((t, i) => <TriggerCard key={i} t={t} />)}
      </div>
    </ScrollArea>
  );
}

function CreateContent({ output, args }: { output: string; args: Record<string, any> }) {
  const result = useMemo(() => parseCreateOutput(output), [output]);
  const name = result?.name || args.name || 'Unknown';
  const id = result?.id;
  const sourceType = args.source_type || (result?.trigger?.sourceType) || 'unknown';
  const SourceIcon = sourceType === 'webhook' ? Webhook : Calendar;

  return (
    <ScrollArea className="h-full w-full">
      <div className="p-4 space-y-4">
        {/* Header card */}
        <div className="flex items-center gap-3 p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
          <div className="p-2.5 rounded-lg bg-emerald-500/10">
            <SourceIcon className="size-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-foreground">{name}</div>
            {id && (
              <div className="text-[10px] text-muted-foreground font-mono truncate">{id}</div>
            )}
          </div>
          <CheckCircle className="size-5 flex-shrink-0 text-emerald-500" />
        </div>

        {/* Config details */}
        <div className="space-y-2">
          {sourceType === 'webhook' && args.path && (
            <DetailRow label="Webhook" value={`POST ${args.path}`} />
          )}
          {sourceType === 'cron' && args.cron_expr && (
            <DetailRow label="Schedule" value={args.cron_expr} />
          )}
          {args.timezone && (
            <DetailRow label="Timezone" value={args.timezone} />
          )}
          {args.action_type && (
            <DetailRow label="Action" value={args.action_type} />
          )}
          {args.agent_name && (
            <DetailRow label="Agent" value={args.agent_name} />
          )}
          {args.session_mode && (
            <DetailRow label="Session" value={args.session_mode} />
          )}
        </div>

        {/* Prompt preview (truncated) */}
        {args.prompt && (
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Prompt</div>
            <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 font-mono whitespace-pre-wrap max-h-40 overflow-auto">
              {args.prompt.length > 500 ? args.prompt.slice(0, 500) + '...' : args.prompt}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground min-w-[70px] text-xs">{label}</span>
      <span className="font-mono text-xs text-foreground truncate">{value}</span>
    </div>
  );
}

function DeleteContent({ output, args }: { output: string; args: Record<string, any> }) {
  const isDeleted = output.toLowerCase().includes('deleted');
  return (
    <div className="flex flex-col items-center justify-center h-full py-12 px-6">
      {isDeleted ? (
        <>
          <div className="p-3 rounded-full bg-muted mb-3">
            <Trash2 className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">Trigger Deleted</p>
          {args.trigger_id && (
            <p className="text-xs text-muted-foreground font-mono">{args.trigger_id}</p>
          )}
        </>
      ) : (
        <>
          <AlertCircle className="h-6 w-6 text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">{output || 'Delete failed'}</p>
        </>
      )}
    </div>
  );
}

function GenericContent({ output }: { output: string }) {
  return (
    <ScrollArea className="h-full w-full">
      <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap font-mono">
        {output.slice(0, 5000)}
      </div>
    </ScrollArea>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function OcTriggersToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const action = (args.action as TriggerAction) || 'list';
  const meta = actionMeta[action] || actionMeta.list;
  const ActionIcon = meta.icon;

  if (isStreaming && !toolResult) {
    return <LoadingState title="Triggers" subtitle={meta.loadingLabel} />;
  }

  // Determine subtitle
  let subtitle: string | undefined;
  if (action === 'create' && args.name) {
    subtitle = args.name;
  } else if (action === 'delete' && args.trigger_id) {
    subtitle = `ID: ${args.trigger_id.slice(0, 8)}...`;
  } else if (action === 'list') {
    const { count } = parseListOutput(output);
    subtitle = `${count} trigger${count !== 1 ? 's' : ''}`;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-muted/50 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={isError ? AlertCircle : ActionIcon}
            title={meta.label}
            subtitle={subtitle}
          />
          {!isStreaming && !isError && (
            <Badge variant="outline" className="h-6 py-0.5 flex-shrink-0 ml-2">
              {action === 'list' ? 'Loaded' : 'Done'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        {isError ? (
          <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{output || toolResult?.error || 'Trigger operation failed'}</p>
          </div>
        ) : action === 'list' ? (
          <ListContent output={output} />
        ) : action === 'create' ? (
          <CreateContent output={output} args={args} />
        ) : action === 'delete' ? (
          <DeleteContent output={output} args={args} />
        ) : (
          <GenericContent output={output} />
        )}
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : action === 'create' ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <Zap className="h-3 w-3" />
              {args.source_type || 'trigger'}
            </Badge>
          ) : action === 'delete' ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <Trash2 className="h-3 w-3" />
              Removed
            </Badge>
          ) : null
        )}
      </ToolViewFooter>
    </Card>
  );
}
