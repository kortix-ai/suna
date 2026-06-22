'use client';

import {
  Activity,
  ArrowLeft,
  ChevronRight,
  Clock,
  Coins,
  DollarSign,
  ScrollText,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { EmptyState } from '@/features/layout/section/empty-state';
import { useGatewayLog, useGatewayLogs } from '@/hooks/projects/use-project-gateway';
import type { GatewayLogRow } from '@/lib/projects-gateway-client';
import { cn } from '@/lib/utils';
import { useGatewayOverlayStore } from '@/stores/gateway-overlay-store';

import { CopyButton, displayModel, modelAccent } from './_shared';

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function latencyTone(ms: number): string {
  if (ms < 800) return 'text-kortix-green';
  if (ms < 2500) return 'text-muted-foreground';
  return 'text-kortix-orange';
}

function StatusBadge({ ok, status }: { ok: boolean; status: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums',
        ok ? 'bg-kortix-green/12 text-kortix-green' : 'bg-destructive/12 text-destructive',
      )}
    >
      <span className={cn('size-1.5 rounded-full', ok ? 'bg-kortix-green' : 'bg-destructive')} />
      {status || (ok ? 200 : 'err')}
    </span>
  );
}

const FILTERS: { key: 'all' | 'ok' | 'err'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ok', label: 'Success' },
  { key: 'err', label: 'Errors' },
];

function LogRow({ row, onClick }: { row: GatewayLogRow; onClick: () => void }) {
  const accent = modelAccent(row.requested_model || row.resolved_model);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group grid w-full grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/50"
    >
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {displayModel(row.requested_model || row.resolved_model)}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {row.provider} · {fmtTime(row.created_at)}
          {!row.ok && row.error_code ? ` · ${row.error_code}` : ''}
        </div>
      </div>
      <span className={cn('hidden text-xs tabular-nums sm:block', latencyTone(row.latency_ms))}>
        {row.latency_ms}ms
      </span>
      <span className="hidden w-20 text-right text-xs tabular-nums text-muted-foreground md:block">
        {(row.input_tokens + row.output_tokens).toLocaleString()} tok
      </span>
      <StatusBadge ok={row.ok} status={row.status} />
      <span className="flex items-center gap-1">
        <span className="w-16 text-right text-xs tabular-nums text-foreground">
          ${row.final_cost.toFixed(4)}
        </span>
        <ChevronRight className="size-4 text-muted-foreground/40 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
      </span>
    </button>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  value: ReactNode;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" style={accent ? { color: accent } : undefined} />
        {label}
      </div>
      <div className="mt-1 text-base font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-right text-sm text-foreground">{value}</span>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <details className="group overflow-hidden rounded-2xl border border-border/60 bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/40">
        <span className="flex items-center gap-2">
          <ChevronRight className="size-4 text-muted-foreground transition-transform duration-150 group-open:rotate-90" />
          {title}
        </span>
        <CopyButton text={text} />
      </summary>
      <pre className="max-h-80 overflow-auto border-t border-border/50 bg-muted/20 p-4 font-mono text-xs leading-relaxed text-foreground">
        {text}
      </pre>
    </details>
  );
}

function GatewayLogDetail({ projectId, logId }: { projectId: string; logId: string }) {
  const selectLog = useGatewayOverlayStore((s) => s.selectLog);
  const { data, isLoading } = useGatewayLog(projectId, logId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/50 bg-background/95 px-4 py-2.5 backdrop-blur">
        <button
          type="button"
          onClick={() => selectLog(null)}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Logs
        </button>
      </div>
      {isLoading || !data ? (
        <div className="space-y-3 p-5">
          <div className="h-24 animate-pulse rounded-2xl bg-muted" />
          <div className="h-40 animate-pulse rounded-2xl bg-muted" />
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-3xl animate-in fade-in-0 flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className="mt-1 size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: modelAccent(data.requested_model) }}
              />
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-foreground">
                  {displayModel(data.requested_model || data.resolved_model)}
                </div>
                <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  {data.request_id}
                  <CopyButton text={data.request_id} className="size-5" />
                </div>
              </div>
            </div>
            <StatusBadge ok={data.ok} status={data.status} />
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <StatTile
              icon={Clock}
              label="Latency"
              value={`${data.latency_ms}ms`}
              accent="var(--chart-2)"
            />
            <StatTile
              icon={Coins}
              label="Tokens"
              value={(data.input_tokens + data.output_tokens).toLocaleString()}
              accent="var(--chart-3)"
            />
            <StatTile
              icon={Activity}
              label="Provider cost"
              value={`$${data.upstream_cost.toFixed(4)}`}
              accent="var(--chart-4)"
            />
            <StatTile
              icon={DollarSign}
              label="Billed"
              value={`$${data.final_cost.toFixed(4)}`}
              accent="var(--chart-1)"
            />
          </div>

          <div className="rounded-2xl border border-border/60 bg-card px-4 py-1">
            <DetailField
              label="Requested model"
              value={<span className="font-mono text-xs">{data.requested_model}</span>}
            />
            <DetailField
              label="Resolved model"
              value={<span className="font-mono text-xs">{data.resolved_model}</span>}
            />
            <DetailField label="Provider" value={data.provider} />
            <DetailField
              label="Tokens"
              value={`${data.input_tokens.toLocaleString()} in · ${data.output_tokens.toLocaleString()} out`}
            />
            <DetailField label="Streaming" value={data.streaming ? 'yes' : 'no'} />
            {data.billing_mode && <DetailField label="Billing mode" value={data.billing_mode} />}
            {data.attempts > 1 && <DetailField label="Attempts" value={data.attempts} />}
          </div>

          {data.error_message && (
            <div className="rounded-2xl border border-destructive/25 bg-card p-4">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                {data.error_code ?? 'Error'}
              </div>
              <div className="whitespace-pre-wrap break-words text-sm text-foreground">
                {data.error_message}
              </div>
            </div>
          )}

          <JsonBlock title="Request" value={data.request} />
          <JsonBlock title="Response" value={data.response} />
        </div>
      )}
    </div>
  );
}

export function GatewayLogs({ projectId }: { projectId: string }) {
  const selectedLogId = useGatewayOverlayStore((s) => s.selectedLogId);
  const selectLog = useGatewayOverlayStore((s) => s.selectLog);
  const [filter, setFilter] = useState<'all' | 'ok' | 'err'>('all');
  const { data, isLoading } = useGatewayLogs(
    projectId,
    filter === 'all' ? undefined : { ok: filter === 'ok' },
  );
  const logs = data?.logs ?? [];

  if (selectedLogId) return <GatewayLogDetail projectId={projectId} logId={selectedLogId} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-2.5">
        <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors duration-150',
                filter === f.key
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-kortix-green" />
          Live · {logs.length}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isLoading && logs.length === 0 ? (
          <div className="divide-y divide-border/40">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <span className="size-2 animate-pulse rounded-full bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-40 animate-pulse rounded-full bg-muted" />
                  <div className="h-2.5 w-24 animate-pulse rounded-full bg-muted" />
                </div>
                <div className="h-4 w-14 animate-pulse rounded-full bg-muted" />
              </div>
            ))}
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={filter === 'err' ? 'No errors in this window' : 'No requests yet'}
            description="Every LLM call routed through the gateway shows up here — model, status, latency, tokens, and cost."
          />
        ) : (
          logs.map((row) => (
            <LogRow key={row.log_id} row={row} onClick={() => selectLog(row.log_id)} />
          ))
        )}
      </div>
    </div>
  );
}
