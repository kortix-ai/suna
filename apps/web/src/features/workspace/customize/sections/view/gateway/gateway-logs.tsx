'use client';

import {
  Activity,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Coins,
  DollarSign,
  ScrollText,
} from 'lucide-react';
import { forwardRef, type ReactNode, useEffect, useRef, useState } from 'react';

import { EmptyState } from '@/features/layout/section/empty-state';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import Hint from '@/components/ui/hint';
import { Skeleton } from '@/components/ui/skeleton';
import { useGatewayLog, useGatewayLogs } from '@/hooks/projects/use-project-gateway';
import type { GatewayLogRow } from '@/lib/projects-gateway-client';
import { cn } from '@/lib/utils';

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

const LogRow = forwardRef<
  HTMLButtonElement,
  { row: GatewayLogRow; focused: boolean; onClick: () => void; onHover: () => void }
>(function LogRow({ row, focused, onClick, onHover }, ref) {
  const accent = modelAccent(row.requested_model || row.resolved_model);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onMouseMove={onHover}
      aria-current={focused ? 'true' : undefined}
      className={cn(
        'group grid w-full scroll-mt-2 grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left transition-colors duration-150',
        focused ? 'bg-primary/[0.06]' : 'hover:bg-muted/50',
      )}
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
      <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
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
        <ChevronRight
          className={cn(
            'size-4 text-muted-foreground/40 transition-transform duration-150',
            focused ? 'translate-x-0.5 text-muted-foreground' : 'group-hover:translate-x-0.5',
          )}
        />
      </span>
    </button>
  );
});

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

function NavButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof ChevronUp;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Hint label={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
      >
        <Icon className="size-4" />
      </button>
    </Hint>
  );
}

function GatewayLogDetail({
  projectId,
  logId,
  index,
  total,
  onBack,
  onPrev,
  onNext,
}: {
  projectId: string;
  logId: string;
  index: number;
  total: number;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { data, isLoading } = useGatewayLog(projectId, logId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border/50 bg-background/95 px-4 py-2.5 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Logs
        </button>
        <div className="flex items-center gap-1.5">
          <span className="text-xs tabular-nums text-muted-foreground/70">
            {index + 1} / {total}
          </span>
          <NavButton icon={ChevronUp} label="Previous (↑)" disabled={index <= 0} onClick={onPrev} />
          <NavButton
            icon={ChevronDown}
            label="Next (↓)"
            disabled={index >= total - 1}
            onClick={onNext}
          />
        </div>
      </div>
      {isLoading || !data ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      ) : (
        <div className="flex w-full animate-in fade-in-0 flex-col gap-4 p-5">
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
            <StatTile icon={Clock} label="Latency" value={`${data.latency_ms}ms`} />
            <StatTile
              icon={Coins}
              label="Tokens"
              value={(data.input_tokens + data.output_tokens).toLocaleString()}
            />
            <StatTile
              icon={Activity}
              label="Provider cost"
              value={`$${data.upstream_cost.toFixed(4)}`}
            />
            <StatTile
              icon={DollarSign}
              label="Billed"
              value={`$${data.final_cost.toFixed(4)}`}
              accent="var(--kortix-blue)"
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
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'ok' | 'err'>('all');
  const [focused, setFocused] = useState(0);
  const { data, isLoading } = useGatewayLogs(
    projectId,
    filter === 'all' ? undefined : { ok: filter === 'ok' },
  );
  const logs = data?.logs ?? [];

  // Keep focus in-bounds as the live list grows/shrinks or the filter changes.
  useEffect(() => {
    setFocused((i) => Math.min(i, Math.max(0, logs.length - 1)));
  }, [logs.length]);
  useEffect(() => setFocused(0), [filter]);

  const focusedRowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!selectedLogId) focusedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focused, selectedLogId]);

  // One global key handler reading the latest state through refs — full keyboard
  // control: ↑/↓ or j/k to move, ↵ to open, ↑/↓ to step through an open entry,
  // Esc/← to go back.
  const state = useRef({ logs, selectedLogId, focused });
  state.current = { logs, selectedLogId, focused };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const { logs: ls, selectedLogId: sel, focused: fi } = state.current;
      if (ls.length === 0) return;
      const down = e.key === 'ArrowDown' || e.key === 'j';
      const up = e.key === 'ArrowUp' || e.key === 'k';

      if (sel) {
        const idx = ls.findIndex((l) => l.log_id === sel);
        if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'h') {
          e.preventDefault();
          setSelectedLogId(null);
        } else if (down && idx < ls.length - 1) {
          e.preventDefault();
          setSelectedLogId(ls[idx + 1].log_id);
          setFocused(idx + 1);
        } else if (up && idx > 0) {
          e.preventDefault();
          setSelectedLogId(ls[idx - 1].log_id);
          setFocused(idx - 1);
        }
        return;
      }

      if (down) {
        e.preventDefault();
        setFocused((i) => Math.min(ls.length - 1, i + 1));
      } else if (up) {
        e.preventDefault();
        setFocused((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const row = ls[fi];
        if (row) setSelectedLogId(row.log_id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (selectedLogId) {
    const idx = logs.findIndex((l) => l.log_id === selectedLogId);
    return (
      <GatewayLogDetail
        projectId={projectId}
        logId={selectedLogId}
        index={idx}
        total={logs.length}
        onBack={() => setSelectedLogId(null)}
        onPrev={() => {
          if (idx > 0) {
            setSelectedLogId(logs[idx - 1].log_id);
            setFocused(idx - 1);
          }
        }}
        onNext={() => {
          if (idx < logs.length - 1) {
            setSelectedLogId(logs[idx + 1].log_id);
            setFocused(idx + 1);
          }
        }}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-2.5">
        <FilterBar>
          {FILTERS.map((f) => (
            <FilterBarItem
              key={f.key}
              onClick={() => setFilter(f.key)}
              data-state={filter === f.key ? 'active' : 'inactive'}
            >
              {f.label}
            </FilterBarItem>
          ))}
        </FilterBar>
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
                <Skeleton className="size-2 shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-40 rounded-full" />
                  <Skeleton className="h-2.5 w-24 rounded-full" />
                </div>
                <Skeleton className="h-4 w-14 rounded-full" />
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
          logs.map((row, i) => (
            <LogRow
              key={row.log_id}
              ref={i === focused ? focusedRowRef : undefined}
              row={row}
              focused={i === focused}
              onHover={() => setFocused(i)}
              onClick={() => setSelectedLogId(row.log_id)}
            />
          ))
        )}
      </div>

      {logs.length > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-t border-border/50 px-4 py-1.5 text-xs text-muted-foreground/60">
          <span><kbd className="font-sans">↑↓</kbd> navigate</span>
          <span><kbd className="font-sans">↵</kbd> open</span>
          <span><kbd className="font-sans">esc</kbd> back</span>
        </div>
      )}
    </div>
  );
}
