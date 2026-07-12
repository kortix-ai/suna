'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AcpPlan, AcpToolCall } from '@kortix/sdk';
import { CheckCircle2, CircleEllipsis, ListTodo, Terminal, XCircle } from 'lucide-react';

export function AcpToolCallCard({ tool, compact = false }: { tool: AcpToolCall; compact?: boolean }) {
  const failed = tool.status === 'failed' || tool.status === 'error';
  const complete = tool.status === 'completed';
  const Icon = failed ? XCircle : complete ? CheckCircle2 : CircleEllipsis;
  const detail = { input: tool.rawInput, output: tool.rawOutput, content: tool.content, locations: tool.locations };
  const hasDetail = Object.values(detail).some((value) => value !== undefined && (!Array.isArray(value) || value.length > 0));
  return (
    <details className="bg-popover group rounded-md border" open={!compact && failed}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <Icon className={cn('size-4 shrink-0', failed ? 'text-destructive' : complete ? 'text-emerald-500' : 'text-muted-foreground animate-pulse')} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{tool.title}</span>
        {tool.toolKind ? <Badge variant="outline" size="xs">{tool.toolKind}</Badge> : null}
        {tool.status ? <span className="text-muted-foreground text-xs capitalize">{tool.status}</span> : null}
      </summary>
      {hasDetail ? <pre className="border-border text-muted-foreground max-h-96 overflow-auto border-t p-3 text-xs whitespace-pre-wrap">{JSON.stringify(detail, null, 2)}</pre> : null}
    </details>
  );
}

export function AcpPlanCard({ plan }: { plan: AcpPlan }) {
  return (
    <div className="bg-popover rounded-md border px-3 py-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium"><ListTodo className="size-4" />Plan</div>
      {plan.entries.length ? (
        <div className="space-y-1.5">{plan.entries.map((entry, index) => <div key={index} className="text-muted-foreground flex gap-2 text-sm"><span className="tabular-nums">{index + 1}.</span><span>{typeof entry === 'string' ? entry : JSON.stringify(entry)}</span></div>)}</div>
      ) : <div className="text-muted-foreground flex items-center gap-2 text-sm"><Terminal className="size-4" />No plan entries</div>}
    </div>
  );
}
