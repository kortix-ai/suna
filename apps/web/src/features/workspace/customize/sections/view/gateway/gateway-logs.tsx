'use client';

import {
  ArrowLeftIcon as ArrowLeft,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  CaretUpIcon as ChevronUp,
  ScrollIcon as ScrollText,
} from '@phosphor-icons/react';
import { Fragment, forwardRef, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { HighlightedCode } from '@/components/markdown/code/code-block';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useGatewayLog, useGatewayLogs } from '@/hooks/projects/use-project-gateway';
import type { GatewayLogRow } from '@/lib/projects-gateway-client';
import { cn } from '@/lib/utils';

import { CopyButton, displayModel } from './_shared';

/**
 * Gateway request log viewer.
 *
 * Two things this file used to get wrong, both fixed here:
 *
 * 1. The filter was `FilterBar`/`FilterBarItem` — a hand-rolled control that
 *    stamps `role="tablist"`/`role="tab"` but never sets `aria-selected`, has no
 *    roving tabindex, and controls no panel. Assistive tech saw three unselected
 *    tabs; keyboard users got no arrow-key movement. It is also not the house
 *    filter control. Replaced with the sanctioned `Tabs`/`TabsListCompact` pair
 *    (Radix — real `aria-selected`, real roving tabindex), same as the analytics
 *    range picker.
 * 2. The header read `Live · {logs.length}`, which looked like a total but was
 *    the page size. `All` and `Success` both showed `100` (the server caps a
 *    page at 100) next to an `Errors` tab showing the true `6` — three numbers
 *    that cannot all be totals, and 100 ≠ 100 + 6. Counts now describe the
 *    loaded window explicitly and say when more rows exist behind them.
 */

type LogFilter = 'all' | 'ok' | 'err';

const FILTERS: { key: LogFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ok', label: 'Success' },
  { key: 'err', label: 'Errors' },
];

const EMPTY_COPY: Record<LogFilter, string> = {
  all: 'No requests yet',
  // The old code branched only on `err`, so an empty `Success` list claimed
  // "No requests yet" while failed requests sat one tab away.
  ok: 'No successful requests',
  err: 'No failed requests',
};

/**
 * Clock time only — the DATE is not on the row.
 *
 * Every row printed "Aug 17, 10:16:54 PM". On a log of 45 calls fired seconds
 * apart, 45 of those characters are the same three and the eye has to walk past
 * them to reach the two digits that differ. The date is a property of a RUN of
 * rows, not of a row, so it is hoisted to `DayDivider` and printed once per
 * day. This is the ordinary log/transcript convention and it is what makes a
 * dense list scannable: what repeats becomes a heading, what varies stays.
 */
function fmtClock(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Full date + time. The DETAIL pane shows one request, so the date costs
 *  nothing there and answering "when exactly" is the point of the field. */
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtDay(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: undefined });
}

export function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * Latency, at the precision a reader can act on.
 *
 * `5735ms` and `1788ms` are four significant figures of which two matter, and
 * they are the same WIDTH, so a slow call and a fast one look alike in a
 * column. `5.7s` next to `1.8s` differ in the first character.
 */
export function fmtLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * A request rejected before routing (a quota gate, a liveness cap) never picked
 * a model, and the columns come back as empty STRINGS rather than nulls. Those
 * rows used to render a blank title over a meta line that opened with a dangling
 * "· ", so every gate rejection looked like a corrupt record. Fall back to what
 * is actually known.
 */
export function logTitle(row: Pick<GatewayLogRow, 'requested_model' | 'resolved_model'>): string {
  const model = row.requested_model || row.resolved_model;
  return model ? displayModel(model) : 'Blocked before routing';
}

/** Join the meta parts that exist — never emit a separator around a blank. */
export function logMeta(parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' · ');
}

/**
 * Outcome, sized by how much it should interrupt you.
 *
 * A success used to render a full green pill reading "200" — 45 identical
 * badges down a list where every call succeeded, the loudest element on the
 * row and the one carrying the least information. A success is now a 6px dot:
 * present, checkable, silent. A FAILURE keeps the pill and gains its code, so
 * the one row worth looking at is the only row shouting.
 */
function StatusMark({ ok, status }: { ok: boolean; status: number }) {
  // Both states occupy the SAME fixed column and share its right edge, so the
  // request text below starts at one x on every row. A pill here would have to
  // size the column for the widest failure and then centre a 6px dot in it —
  // and, at 0.75rem, overflowed into the model name instead.
  if (ok) {
    return (
      <span
        title={`${status || 200}`}
        aria-label={`Status ${status || 200}`}
        className="bg-kortix-green/70 size-1.5 shrink-0 justify-self-end rounded-full"
      />
    );
  }
  return (
    <span
      aria-label={`Status ${status || 'error'}`}
      className="text-kortix-red justify-self-end text-xs font-medium whitespace-nowrap tabular-nums"
    >
      {status || 'err'}
    </span>
  );
}

/**
 * The same outcome, at full size, for the DETAIL pane.
 *
 * One request on screen instead of forty-five, so the status is not repetition
 * — it is the answer to the question the pane was opened to ask, and it gets
 * the pill in both directions.
 */
function StatusBadge({ ok, status }: { ok: boolean; status: number }) {
  return (
    <Badge
      variant="outline"
      size="sm"
      className={cn(
        'gap-1 tabular-nums',
        ok
          ? 'bg-kortix-green/12 text-kortix-green border-transparent'
          : 'bg-kortix-red/12 text-kortix-red border-transparent',
      )}
    >
      <span className={cn('size-1.5 rounded-full', ok ? 'bg-kortix-green' : 'bg-kortix-red')} />
      {status || (ok ? 200 : 'err')}
    </Badge>
  );
}

/** The shared column grid. The header and every row use THIS and nothing else —
 *  two grids that merely look alike drift the first time a column changes. */
const LOG_GRID =
  // Time gets 5.5rem because a 12-hour clock with AM/PM does not fit in less,
  // and a wrapped time cell puts the two-line row straight back.
  'grid w-full grid-cols-[2rem_minmax(0,1fr)_5.5rem_3.25rem_4rem_4.5rem_1rem] items-center gap-x-3 px-2';

/**
 * The numeric columns, named once at the top instead of per row.
 *
 * The units used to ride every cell — `5735ms`, `38,390 tok` — because nothing
 * said what the columns were. That is 45 copies of "ms" and 45 of "tok" in a
 * list whose whole problem is repetition. A header states each one once and the
 * cells go back to being numbers.
 */
function LogListHeader() {
  return (
    <div
      className={cn(
        LOG_GRID,
        'text-muted-foreground/70 border-border/40 sticky top-0 z-10 border-b py-1.5 text-[11px]',
        'bg-background/95 backdrop-blur',
      )}
    >
      <span />
      <span>Request</span>
      <span className="text-right">Time</span>
      <span className="hidden text-right sm:block">Latency</span>
      <span className="hidden text-right md:block">Tokens</span>
      <span className="text-right">Cost</span>
      <span />
    </div>
  );
}

/**
 * The date, once per run of rows that share it — see `fmtClock`.
 */
function DayDivider({ iso }: { iso: string }) {
  return (
    <div className="text-muted-foreground/60 bg-muted/20 border-border/40 border-b px-4 py-1 text-[11px] font-medium">
      {fmtDay(iso)}
    </div>
  );
}

const LogRow = forwardRef<
  HTMLButtonElement,
  { row: GatewayLogRow; focused: boolean; onClick: () => void; onHover: () => void }
>(function LogRow({ row, focused, onClick, onHover }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onMouseMove={onHover}
      aria-current={focused ? 'true' : undefined}
      className={cn(
        // ONE line, not two. The second line held the provider and a date that
        // was the same on every row, and it doubled the height of a list whose
        // job is to show many rows at once.
        LOG_GRID,
        'group border-border/40 scroll-mt-2 border-b py-2 text-left transition-colors duration-150',
        focused ? 'bg-primary/[0.06]' : 'hover:bg-muted/50',
      )}
    >
      <StatusMark ok={row.ok} status={row.status} />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="text-foreground truncate text-sm">{logTitle(row)}</span>
        {/* Provider and any error code sit BESIDE the model at lower contrast,
            not under it. They qualify the model; they are not a second line of
            equal standing. */}
        <span
          className={cn(
            'truncate text-xs',
            // A failed row carries its reason in the same red as its status, so
            // the two cues that matter read as one.
            row.ok ? 'text-muted-foreground/70' : 'text-kortix-red/80',
          )}
        >
          {logMeta([row.provider, !row.ok && row.error_code])}
        </span>
      </span>
      <span className="text-muted-foreground/80 text-right text-xs whitespace-nowrap tabular-nums">
        {fmtClock(row.created_at)}
      </span>
      <span className="text-muted-foreground hidden text-right text-xs whitespace-nowrap tabular-nums sm:block">
        {fmtLatency(row.latency_ms)}
      </span>
      <span className="text-muted-foreground hidden text-right text-xs whitespace-nowrap tabular-nums md:block">
        {(row.input_tokens + row.output_tokens).toLocaleString()}
      </span>
      <span className="text-foreground text-right text-xs whitespace-nowrap tabular-nums">
        {/* What the request cost YOU — the full caller-facing total, not
            just the Kortix-billed slice (`kortix_cost`, 0 on a plain BYOK
            call with no platform fee). */}
        ${row.total_cost.toFixed(4)}
      </span>
      <ChevronRight
        className={cn(
          'text-muted-foreground/40 size-4 transition-transform duration-150',
          focused ? 'text-muted-foreground translate-x-0.5' : 'group-hover:translate-x-0.5',
        )}
      />
    </button>
  );
});

function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="bg-popover rounded-md border px-3 py-2">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground mt-0.5 text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Who charged for this request, in the caller's own terms.
 *
 * `credits` = Kortix-managed inference on Kortix's credentials, paid from the
 * wallet. `platform-fee` = your own provider key, plus the Kortix platform
 * fee. `none` = your own provider key with no Kortix charge at all (self-host
 * and free tier), or a flat-rate subscription route such as ChatGPT Codex.
 */
function billedByLabel(billingMode: string | null, provider: string): string {
  switch (billingMode) {
    case 'credits':
      return 'Kortix credits';
    case 'platform-fee':
      return `your ${provider} key + Kortix fee`;
    case 'none':
      return `your ${provider} key`;
    default:
      return provider;
  }
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-foreground truncate text-right text-sm">{value}</span>
    </div>
  );
}

/**
 * Pretty-print whatever the gateway stored. Bodies arrive as parsed JSON, but a
 * streamed or non-JSON upstream response lands as a raw string — parse those so
 * they render as formatted JSON too instead of one unbroken line.
 */
export function formatPayload(value: unknown): { text: string; language: string } {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return { text: JSON.stringify(JSON.parse(trimmed), null, 2), language: 'json' };
      } catch {
        /* not JSON after all — fall through to plain text */
      }
    }
    return { text: value, language: 'text' };
  }
  // A streamed upstream response is stored wrapped, as `{ value: "<raw SSE>" }`.
  // Stringifying that object re-escapes every newline, so a 1,000-frame stream
  // collapses into ONE unreadable line — the exact thing this viewer must not
  // do. Unwrap the lone string field and render its real line breaks.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1) {
      const [, only] = entries[0];
      if (typeof only === 'string' && only.includes('\n')) return formatPayload(only);
    }
  }
  return { text: JSON.stringify(value, null, 2), language: 'json' };
}

/** Small payloads open on sight; anything taller than a screenful starts folded
 *  so the detail view stays scannable. */
const AUTO_COLLAPSE_LINES = 40;

function PayloadBlock({ title, value }: { title: string; value: unknown }) {
  const { text, language } = useMemo(() => formatPayload(value), [value]);
  const lines = useMemo(() => text.split('\n').length, [text]);

  if (value == null || text === '' || text === 'null') return null;

  return (
    <Disclosure variant="outline" defaultOpen={lines <= AUTO_COLLAPSE_LINES}>
      <DisclosureTrigger variant="outline">
        {/* Header is the trigger and nothing else — the copy control lives over
            the body, so no interactive element is nested inside a role=button. */}
        <div className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors">
          <ChevronRight className="text-muted-foreground size-4 transition-transform duration-150 group-data-[state=open]:rotate-90" />
          <span className="text-foreground">{title}</span>
          <span className="text-muted-foreground text-xs font-normal tabular-nums">
            {lines.toLocaleString()} {lines === 1 ? 'line' : 'lines'}
          </span>
        </div>
      </DisclosureTrigger>
      <DisclosureContent variant="outline">
        <div className="relative">
          <pre className="border-border/50 bg-muted/20 text-foreground max-h-96 overflow-auto border-t p-4 pr-12 font-mono text-xs leading-relaxed [&_code]:text-xs">
            {/* This viewer exists to show exactly what was sent/received —
                the highlighter's length clamp (a perf guard for chat code
                blocks re-rendered per streamed token) must not apply here. */}
            <HighlightedCode code={text} language={language} unbounded />
          </pre>
          <div className="absolute top-2 right-2">
            <CopyButton text={text} />
          </div>
        </div>
      </DisclosureContent>
    </Disclosure>
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
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30"
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
      <div className="border-border/50 bg-background/95 sticky top-0 z-10 flex items-center justify-between gap-2 border-b px-4 py-2.5 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors"
        >
          <ArrowLeft className="size-4" /> Logs
        </button>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground/70 text-xs tabular-nums">
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
          <Skeleton className="h-24 rounded-md" />
          <Skeleton className="h-40 rounded-md" />
        </div>
      ) : (
        <div className="animate-in fade-in-0 flex w-full flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-foreground truncate text-base font-semibold">
                {logTitle(data)}
              </div>
              <div className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
                {data.request_id}
                <CopyButton text={data.request_id} className="size-5" />
              </div>
            </div>
            <StatusBadge ok={data.ok} status={data.status} />
          </div>

          {/* Money tiles show only what the CALLER paid. On a Kortix-managed
              (`credits`) request the upstream price is Kortix's wholesale cost,
              not the caller's — the API never sends it, so there is no
              "provider cost" tile to render for one. A BYOK request that also
              carries a Kortix platform fee is the only case with two payees,
              and only that case gets the fourth tile. */}
          <div
            className={cn(
              'grid grid-cols-2 gap-2',
              data.kortix_cost > 0 && data.provider_cost > 0 ? 'sm:grid-cols-4' : 'sm:grid-cols-3',
            )}
          >
            <StatTile label="Latency" value={`${data.latency_ms}ms`} />
            <StatTile
              label="Tokens"
              value={(data.input_tokens + data.output_tokens).toLocaleString()}
            />
            <StatTile label="Cost" value={`$${data.total_cost.toFixed(4)}`} />
            {data.kortix_cost > 0 && data.provider_cost > 0 && (
              <StatTile label="Kortix fee" value={`$${data.kortix_cost.toFixed(4)}`} />
            )}
          </div>

          <div className="bg-popover rounded-md border px-4 py-1">
            {/* An em dash beats an empty cell — the field exists, the value does
                not, and the reader should be able to tell those apart. */}
            <DetailField
              label="Requested model"
              value={<span className="font-mono text-xs">{data.requested_model || '—'}</span>}
            />
            <DetailField
              label="Resolved model"
              value={<span className="font-mono text-xs">{data.resolved_model || '—'}</span>}
            />
            <DetailField label="Provider" value={data.provider || '—'} />
            <DetailField label="Received" value={fmtTime(data.created_at)} />
            <DetailField
              label="Tokens"
              value={`${data.input_tokens.toLocaleString()} in · ${data.output_tokens.toLocaleString()} out`}
            />
            {(data.cached_tokens > 0 || data.cache_write_tokens > 0) && (
              <DetailField
                label="Cache"
                value={`${data.cached_tokens.toLocaleString()} read · ${data.cache_write_tokens.toLocaleString()} write`}
              />
            )}
            <DetailField label="Streaming" value={data.streaming ? 'yes' : 'no'} />
            {/* Was "Billing mode: none", which reads as "this call was free"
                and is the reason a $0.00 next to a real provider charge looked
                like a bug rather than a BYOK route. Name the payee instead. */}
            <DetailField label="Billed by" value={billedByLabel(data.billing_mode, data.provider)} />
            {data.attempts > 1 && <DetailField label="Attempts" value={data.attempts} />}
            {/* Fetched by the route since day one and never rendered — it is the
                only place the fallback chain that actually ran is visible. */}
            {data.candidates_tried.length > 0 && (
              <DetailField
                label="Models tried"
                value={
                  <span className="font-mono text-xs">{data.candidates_tried.join(' → ')}</span>
                }
              />
            )}
          </div>

          {data.error_message && (
            <div className="border-kortix-red/25 bg-popover rounded-md border p-4">
              <div className="text-muted-foreground mb-1 text-xs font-medium">
                {data.error_code ?? 'Error'}
              </div>
              <div className="text-foreground text-sm wrap-break-word whitespace-pre-wrap">
                {data.error_message}
              </div>
            </div>
          )}

          <PayloadBlock title="Request" value={data.request} />
          <PayloadBlock title="Response" value={data.response} />
          {Object.keys(data.metadata).length > 0 && (
            <PayloadBlock title="Metadata" value={data.metadata} />
          )}
        </div>
      )}
    </div>
  );
}

export function GatewayLogs({ projectId }: { projectId: string }) {
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [focused, setFocused] = useState(0);
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useGatewayLogs(
    projectId,
    filter === 'all' ? undefined : { ok: filter === 'ok' },
  );
  const logs = useMemo(() => data?.pages.flatMap((p) => p.logs) ?? [], [data]);
  // Polling is on only while the newest page is the only page — see the hook.
  const isLive = (data?.pages.length ?? 1) <= 1;

  // Clamp on read rather than in an effect: the live list shrinks under the
  // cursor whenever a page drops rows, and an effect would render once with an
  // out-of-range index before correcting it.
  const focusedIndex = Math.min(focused, Math.max(0, logs.length - 1));

  const focusedRowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!selectedLogId) focusedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex, selectedLogId]);

  // One global key handler reading the latest state through refs — full keyboard
  // control: ↑/↓ or j/k to move, ↵ to open, ↑/↓ to step through an open entry,
  // Esc/← to go back.
  const state = useRef({ logs, selectedLogId, focused: focusedIndex });
  useEffect(() => {
    state.current = { logs, selectedLogId, focused: focusedIndex };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Let browser/OS shortcuts through untouched.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A tab keeps DOM focus after it is clicked. Enter/Space activate that
      // tab, and ←/→/Home/End drive its roving focus — so while focus sits in a
      // tablist those keys belong to the tablist, not to this list. Without the
      // guard, pressing Enter on the "Errors" tab re-applied the filter AND ran
      // the Enter branch below, opening whatever row happened to be focused.
      // ↑/↓/j/k are not tablist keys, so they still drive the list from here.
      if (
        t?.closest('[data-slot="log-filter"], [role="tablist"]') &&
        ['Enter', ' ', 'Spacebar', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)
      ) {
        return;
      }
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
      <div className="border-border/50 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5">
        <div data-slot="log-filter">
          <Tabs
            value={filter}
            onValueChange={(v) => {
              setFilter(v as LogFilter);
              // Switching filter swaps the whole list, so the cursor goes back
              // to the top with it — done here, not in an effect.
              setFocused(0);
            }}
          >
            <TabsListCompact aria-label="Filter requests by outcome">
              {FILTERS.map((f) => (
                <TabsTriggerCompact key={f.key} value={f.key}>
                  {f.label}
                </TabsTriggerCompact>
              ))}
            </TabsListCompact>
          </Tabs>
        </div>
        {/* "shown", not a total. The route returns a page and never a count, so
            any number here that claimed to be a total would be a guess — which
            is exactly how `All` and `Success` both came to read "100" next to an
            `Errors` tab reading the true "6". */}
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs tabular-nums">
          {!isLoading && <>{logs.length.toLocaleString()} shown</>}
          {isLive && (
            <>
              <span className="bg-kortix-green size-1.5 animate-pulse rounded-full" />
              Live
            </>
          )}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isLoading && logs.length === 0 ? (
          <div className="divide-border/40 divide-y">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
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
            size="sm"
            title={EMPTY_COPY[filter]}
            description="Every LLM call routed through the gateway shows up here — model, status, latency, tokens, and cost."
          />
        ) : (
          <>
            <LogListHeader />
            {logs.map((row, i) => (
              <Fragment key={row.log_id}>
                {/* The date, once, above the run of rows it covers. */}
                {(i === 0 || !sameDay(logs[i - 1].created_at, row.created_at)) && (
                  <DayDivider iso={row.created_at} />
                )}
                <LogRow
                  ref={i === focusedIndex ? focusedRowRef : undefined}
                  row={row}
                  focused={i === focusedIndex}
                  onHover={() => setFocused(i)}
                  onClick={() => setSelectedLogId(row.log_id)}
                />
              </Fragment>
            ))}
            {hasNextPage && (
              <div className="flex justify-center px-4 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? <Loading className="size-3.5 shrink-0" /> : null}
                  Load older requests
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {logs.length > 0 && (
        <div className="border-border/50 text-muted-foreground/60 flex shrink-0 items-center gap-3 border-t px-4 py-1.5 text-xs">
          <span>
            <kbd className="font-sans">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-sans">↵</kbd> open
          </span>
          <span>
            <kbd className="font-sans">esc</kbd> back
          </span>
        </div>
      )}
    </div>
  );
}
