'use client';

import {
  CaretDownIcon as ChevronDown,
  CaretUpIcon as ChevronUp,
  MagnifyingGlassIcon as Search,
  XIcon,
  ScrollIcon as ScrollText,
} from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { Fragment, forwardRef, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { HighlightedCode } from '@/components/markdown/code/code-block';
import { Badge } from '@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SplitSheetBody,
  SplitSheetDescription,
  SplitSheetHeader,
  SplitSheetTitle,
} from '@/components/ui/split-sheet';
import { useModelsPageSheet } from '@/features/workspace/customize/sections/models-page-sheet';
import { Tabs, TabsContent, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
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

export type LogFilter = 'all' | 'ok' | 'err';

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

/** Search over the LOADED rows: model, provider and error code. */
export function matchesLogQuery(
  row: Pick<GatewayLogRow, 'requested_model' | 'resolved_model' | 'provider' | 'error_code'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.requested_model, row.resolved_model, row.provider, row.error_code].some(
    (v) => typeof v === 'string' && v.toLowerCase().includes(q),
  );
}

/** Median latency of the given rows, in ms. `null` when there are none. */
export function medianLatency(rows: Pick<GatewayLogRow, 'latency_ms'>[]): number | null {
  const values = rows
    .map((r) => r.latency_ms)
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

export interface LogBucket {
  /** Start of the bucket, epoch ms. */
  start: number;
  /** End of the bucket, epoch ms. The last bucket includes its end. */
  end: number;
  total: number;
  errors: number;
}

export interface LogBucketStats extends LogBucket {
  /** 0–1, or null for an empty bucket. */
  successRate: number | null;
  medianLatency: number | null;
  tokens: number;
  cost: number;
  /** The model with the most requests in the bucket. */
  topModel: string | null;
}

type BucketRow = Pick<
  GatewayLogRow,
  'created_at' | 'ok' | 'latency_ms' | 'input_tokens' | 'output_tokens' | 'total_cost' | 'requested_model' | 'resolved_model'
>;

/**
 * The loaded rows, split into `count` equal time slices from the oldest loaded
 * row to the newest, with each slice's stats. It describes the window on
 * screen, not all traffic: the route returns pages, never totals.
 */
export function bucketLogStats(rows: BucketRow[], count: number): LogBucketStats[] {
  const times = rows.map((r) => new Date(r.created_at).getTime()).filter(Number.isFinite);
  if (times.length === 0 || count < 1) return [];
  const min = Math.min(...times);
  const max = Math.max(...times);
  const size = Math.max(1, max - min) / count;
  const groups: BucketRow[][] = Array.from({ length: count }, () => []);
  rows.forEach((row) => {
    const t = new Date(row.created_at).getTime();
    if (!Number.isFinite(t)) return;
    groups[Math.min(count - 1, Math.floor((t - min) / size))].push(row);
  });
  return groups.map((group, i) => {
    const errors = group.filter((r) => !r.ok).length;
    const models = new Map<string, number>();
    group.forEach((r) => {
      const model = logTitle(r);
      models.set(model, (models.get(model) ?? 0) + 1);
    });
    const topModel = [...models.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    return {
      start: min + i * size,
      end: i === count - 1 ? max : min + (i + 1) * size,
      total: group.length,
      errors,
      successRate: group.length ? (group.length - errors) / group.length : null,
      medianLatency: medianLatency(group),
      tokens: group.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0),
      cost: group.reduce((n, r) => n + r.total_cost, 0),
      topModel,
    };
  });
}

/** Counts only — see `bucketLogStats`. */
export function bucketLogs(rows: BucketRow[], count: number): LogBucket[] {
  return bucketLogStats(rows, count).map(({ start, end, total, errors }) => ({ start, end, total, errors }));
}

/** A time window a bar click narrows the list to. */
export interface LogTimeRange {
  start: number;
  end: number;
}

/** True when the row falls inside the window (both ends inclusive). */
export function inLogRange(row: Pick<GatewayLogRow, 'created_at'>, range: LogTimeRange | null): boolean {
  if (!range) return true;
  const t = new Date(row.created_at).getTime();
  return t >= range.start && t <= range.end;
}

/** "10:58 – 11:03 pm" — the bucket's clock range. */
export function fmtRange(range: LogTimeRange): string {
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${clock(range.start)} – ${clock(range.end)}`;
}

/**
 * The filter tabs' counts, over the LOADED window only. On `All` the loaded
 * rows answer all three; on a narrowed tab only that tab's own count is known,
 * so the other two show none rather than a guess.
 */
export function filterCounts(
  filter: LogFilter,
  rows: Pick<GatewayLogRow, 'ok'>[],
  loading: boolean,
): Record<LogFilter, number | null> {
  if (loading) return { all: null, ok: null, err: null };
  if (filter === 'all') {
    const errors = rows.filter((r) => !r.ok).length;
    return { all: rows.length, ok: rows.length - errors, err: errors };
  }
  return { all: null, ok: null, err: null, [filter]: rows.length } as Record<LogFilter, number | null>;
}

/**
 * Outcome as an 8px dot in its own lane: green for success, red for failure.
 * A failed row also carries its status and error code beside the provider, in
 * the same red, so the one row worth looking at is the only one that is red.
 */
function StatusMark({ ok, status }: { ok: boolean; status: number }) {
  return (
    <span
      title={`${status || (ok ? 200 : 'error')}`}
      aria-label={`Status ${status || (ok ? 200 : 'error')}`}
      className={cn('size-2 shrink-0 rounded-full', ok ? 'bg-kortix-green' : 'bg-destructive')}
    />
  );
}

/**
 * The same outcome, at full size, for the DETAIL pane.
 *
 * One request on screen instead of forty-five, so the status is not repetition
 * — it is the answer to the question the pane was opened to ask, and it gets
 * the pill in both directions.
 */
function StatusBadge({
  ok,
  status,
  errorCode,
}: {
  ok: boolean;
  status: number;
  errorCode?: string | null;
}) {
  return (
    <Badge variant={ok ? 'success' : 'destructive'} size="sm" className="shrink-0 tabular-nums">
      {logMeta([`${status || (ok ? 200 : 'err')}`, !ok && errorCode])}
    </Badge>
  );
}

/**
 * The column lanes. The header and every row use these widths and nothing
 * else, so the numbers line up down the list. Latency and tokens fold away when
 * the list is narrow (the detail sheet is open on a small window).
 */
const LANE = {
  // "12:55:01 am" at text-xs is ~76px; w-22 holds it on one line.
  time: 'w-22 shrink-0 text-right whitespace-nowrap',
  latency: 'w-14 shrink-0 text-right whitespace-nowrap @max-sm/logs:hidden',
  tokens: 'w-16 shrink-0 text-right whitespace-nowrap @max-md/logs:hidden',
  cost: 'w-16 shrink-0 text-right whitespace-nowrap',
} as const;

/** The numeric columns, named once at the top instead of per row. */
function LogListHeader() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="text-muted-foreground border-border flex h-8 shrink-0 items-center gap-3 border-b px-3 text-xs">
      <span className="w-2 shrink-0" />
      <span className="min-w-0 flex-1">{tI18nComplete.raw('text59f03d642b41')}</span>
      <span className={LANE.time}>{tI18nComplete.raw('text33b93476cf59')}</span>
      <span className={LANE.latency}>{tI18nComplete.raw('texte0e7d293043c')}</span>
      <span className={LANE.tokens}>{tI18nComplete.raw('texta039dfb9628b')}</span>
      <span className={LANE.cost}>{tI18nComplete.raw('text204a5eb2cd28')}</span>
    </div>
  );
}

/** The date, once per run of rows that share it — see `fmtClock`. */
function DayDivider({ iso }: { iso: string }) {
  return (
    <div className="text-muted-foreground px-3 pt-3.5 pb-1.5 text-xs font-medium">{fmtDay(iso)}</div>
  );
}

const LogRow = forwardRef<
  HTMLButtonElement,
  { row: GatewayLogRow; focused: boolean; selected: boolean; onClick: () => void; onHover: () => void }
>(function LogRow({ row, focused, selected, onClick, onHover }, ref) {
  // A failed call that never reached a model has no tokens and no cost; a dash
  // says "nothing" instead of a 0 that reads like a measurement.
  const empty = !row.ok && row.input_tokens + row.output_tokens === 0;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onMouseMove={onHover}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex h-10 w-full shrink-0 scroll-mt-10 items-center gap-3 rounded-md px-3 text-left text-xs',
        'transition-[background-color] duration-(--duration-normal)',
        selected ? 'bg-muted' : focused ? 'bg-muted/60' : 'hover:bg-muted/60',
      )}
    >
      <StatusMark ok={row.ok} status={row.status} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="text-foreground truncate font-medium">{logTitle(row)}</span>
        {row.provider ? (
          <span className="text-muted-foreground shrink-0 truncate font-mono">{row.provider}</span>
        ) : null}
        {!row.ok ? (
          <span className="text-destructive truncate font-mono">
            {logMeta([row.status ? `${row.status}` : null, row.error_code])}
          </span>
        ) : null}
      </span>
      <span className={cn(LANE.time, 'text-muted-foreground tabular-nums')}>{fmtClock(row.created_at)}</span>
      <span className={cn(LANE.latency, 'text-foreground tabular-nums')}>{fmtLatency(row.latency_ms)}</span>
      <span className={cn(LANE.tokens, 'tabular-nums', empty ? 'text-muted-foreground' : 'text-foreground')}>
        {empty ? '—' : (row.input_tokens + row.output_tokens).toLocaleString()}
      </span>
      <span className={cn(LANE.cost, 'tabular-nums', empty ? 'text-muted-foreground' : 'text-foreground')}>
        {/* What the request cost YOU — the full caller-facing total, not just
            the Kortix-billed slice (`kortix_cost`, 0 on a plain BYOK call). */}
        {empty ? '—' : `$${row.total_cost.toFixed(4)}`}
      </span>
    </button>
  );
});

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
    <div className="flex items-baseline justify-between gap-4 py-2 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground min-w-0 truncate text-right">{value}</span>
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

/** One stat in the detail pane's strip: latency, tokens, cost. */
function StatCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2.5">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground truncate text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

/** A stored body, pretty-printed, with Copy. Highlighting is unbounded: this
 *  viewer exists to show exactly what was sent and received. */
function PayloadCode({ value }: { value: unknown }) {
  const { text, language } = useMemo(() => formatPayload(value), [value]);
  return (
    <div className="relative">
      <pre className="bg-muted text-foreground max-h-96 overflow-auto rounded-md px-3.5 py-3 pr-12 font-mono text-xs leading-normal [&_code]:text-xs">
        <HighlightedCode code={text} language={language} unbounded />
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={text} />
      </div>
    </div>
  );
}

function hasPayload(value: unknown): boolean {
  if (value == null) return false;
  const { text } = formatPayload(value);
  return text !== '' && text !== 'null';
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
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 items-center justify-center rounded-md transition-[background-color,color] duration-(--duration-normal) disabled:pointer-events-none disabled:opacity-30"
      >
        <Icon className="size-3.5" />
      </button>
    </Hint>
  );
}

/**
 * One request, in the split sheet beside the list. The list stays on screen,
 * so ↑/↓ (or the arrows by the timestamp) step through requests while this
 * pane follows.
 */
function GatewayLogDetail({
  projectId,
  logId,
  index,
  total,
  onPrev,
  onNext,
}: {
  projectId: string;
  logId: string;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('gatewayLogs');
  const { data, isLoading } = useGatewayLog(projectId, logId);

  const payloads = data
    ? [
        { key: 'request', label: tI18nComplete.raw('text59f03d642b41'), value: data.request },
        { key: 'response', label: tI18nComplete.raw('text9061383b8e22'), value: data.response },
        ...(Object.keys(data.metadata).length > 0
          ? [{ key: 'metadata', label: tI18nComplete.raw('text9eddf573cb50'), value: data.metadata as unknown }]
          : []),
      ].filter((p) => hasPayload(p.value))
    : [];

  return (
    <>
      <SplitSheetHeader closeLabel={t('close')} className="px-6 pt-5 pb-4">
        <div className="flex min-w-0 items-center gap-2">
          <SplitSheetTitle className="truncate text-base font-semibold">
            {data ? logTitle(data) : '\u00a0'}
          </SplitSheetTitle>
          {data ? <StatusBadge ok={data.ok} status={data.status} errorCode={data.error_code} /> : null}
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <SplitSheetDescription className="min-w-0 truncate tabular-nums">
            {data ? fmtTime(data.created_at) : null}
          </SplitSheetDescription>
          <div className="flex shrink-0 items-center gap-0.5">
            <span className="text-muted-foreground mr-1 text-xs tabular-nums">
              {index + 1} / {total}
            </span>
            <NavButton
              icon={ChevronUp}
              label={tI18nComplete.raw('text7de83ebed3ea')}
              disabled={index <= 0}
              onClick={onPrev}
            />
            <NavButton
              icon={ChevronDown}
              label={tI18nComplete.raw('text14a2f02e188f')}
              disabled={index >= total - 1}
              onClick={onNext}
            />
          </div>
        </div>
        {data ? (
          <div className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
            <span className="truncate font-mono">{data.request_id}</span>
            <CopyButton text={data.request_id} className="size-5 shrink-0" />
          </div>
        ) : null}
      </SplitSheetHeader>
      <SplitSheetBody className="flex flex-col gap-6 px-6 pt-5 pb-6">
        {isLoading || !data ? (
          <div className="space-y-3">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-40 rounded-md" />
          </div>
        ) : (
          <>
            {data.error_message && (
              <div className="bg-destructive/10 flex flex-col gap-1 rounded-md px-3.5 py-3">
                {data.error_code ? (
                  <div className="text-destructive font-mono text-xs">{data.error_code}</div>
                ) : null}
                <div className="text-destructive text-xs wrap-break-word whitespace-pre-wrap">
                  {data.error_message}
                </div>
              </div>
            )}

            {/* Money cells show only what the CALLER paid. A BYOK request that
                also carries a Kortix platform fee is the only case with two
                payees, and only that case gets the fourth cell. */}
            <div className="ring-border divide-border flex divide-x rounded-md ring-1">
              <StatCell label={tI18nComplete.raw('texte0e7d293043c')} value={fmtLatency(data.latency_ms)} />
              <StatCell
                label={tI18nComplete.raw('texta039dfb9628b')}
                value={(data.input_tokens + data.output_tokens).toLocaleString()}
              />
              <StatCell label={tI18nComplete.raw('text204a5eb2cd28')} value={`$${data.total_cost.toFixed(4)}`} />
              {data.kortix_cost > 0 && data.provider_cost > 0 && (
                <StatCell
                  label={tI18nComplete.raw('text27343e44b3f1')}
                  value={`$${data.kortix_cost.toFixed(4)}`}
                />
              )}
            </div>

            {/* An em dash beats an empty cell — the field exists, the value
                does not, and the reader should be able to tell those apart. */}
            <div className="divide-border flex flex-col divide-y">
              <DetailField
                label={tI18nComplete.raw('textb36591f91a8c')}
                value={<span className="font-mono">{data.requested_model || '—'}</span>}
              />
              <DetailField
                label={tI18nComplete.raw('textac811767e2f7')}
                value={<span className="font-mono">{data.resolved_model || '—'}</span>}
              />
              <DetailField label={tI18nComplete.raw('text472590ae974d')} value={data.provider || '—'} />
              {/* The only place the fallback chain that actually ran is visible. */}
              {data.candidates_tried.length > 0 && (
                <DetailField
                  label={tI18nComplete.raw('text8281b9f426fd')}
                  value={<span className="font-mono">{data.candidates_tried.join(' → ')}</span>}
                />
              )}
              {data.attempts > 1 && (
                <DetailField label={tI18nComplete.raw('text06e70139fcf5')} value={data.attempts} />
              )}
              <DetailField
                label={tI18nComplete.raw('texta039dfb9628b')}
                value={`${data.input_tokens.toLocaleString()} in · ${data.output_tokens.toLocaleString()} out`}
              />
              {(data.cached_tokens > 0 || data.cache_write_tokens > 0) && (
                <DetailField
                  label={tI18nComplete.raw('texta76ce82a9749')}
                  value={`${data.cached_tokens.toLocaleString()} read · ${data.cache_write_tokens.toLocaleString()} write`}
                />
              )}
              <DetailField
                label={tI18nComplete.raw('texta951c5945635')}
                value={data.streaming ? 'yes' : 'no'}
              />
              {/* Name the payee: "Billing mode: none" read as "this call was free". */}
              <DetailField
                label={tI18nComplete.raw('text88b1dfafbd5f')}
                value={billedByLabel(data.billing_mode, data.provider)}
              />
            </div>

            {payloads.length > 0 ? (
              <Tabs defaultValue={payloads[0].key} className="gap-2">
                <TabsListCompact className="self-start">
                  {payloads.map((p) => (
                    <TabsTriggerCompact key={p.key} value={p.key}>
                      {p.label}
                    </TabsTriggerCompact>
                  ))}
                </TabsListCompact>
                {payloads.map((p) => (
                  <TabsContent key={p.key} value={p.key}>
                    <PayloadCode value={p.value} />
                  </TabsContent>
                ))}
              </Tabs>
            ) : null}
          </>
        )}
      </SplitSheetBody>
    </>
  );
}

/** Bars per histogram. */
const HISTOGRAM_BUCKETS = 48;

/** What one bar holds, shown on hover or keyboard focus. */
export function LogBucketCard({ bucket }: { bucket: LogBucketStats }) {
  const t = useTranslations('gatewayLogs');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const stats: [string, ReactNode][] = [
    [
      t('cardErrors'),
      <span key="errors" className={bucket.errors > 0 ? 'text-destructive' : undefined}>
        {bucket.errors.toLocaleString()}
      </span>,
    ],
    [t('successRate'), `${Math.round((bucket.successRate ?? 0) * 100)}%`],
    [t('cardMedianLatency'), bucket.medianLatency != null ? fmtLatency(bucket.medianLatency) : '—'],
    [tI18nComplete.raw('texta039dfb9628b'), bucket.tokens.toLocaleString()],
    [tI18nComplete.raw('text204a5eb2cd28'), `$${bucket.cost.toFixed(4)}`],
  ];
  return (
    <div className="flex flex-col gap-2 tabular-nums" data-slot="log-bucket-card">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-foreground font-medium whitespace-nowrap">{fmtRange(bucket)}</span>
        <span className="text-muted-foreground whitespace-nowrap">
          {bucket.total.toLocaleString()} {t('requestsLabel', { count: bucket.total })}
        </span>
      </div>
      <div className="border-border border-t" />
      {bucket.total ? (
        <>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
            {stats.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-foreground text-right">{value}</dd>
              </Fragment>
            ))}
          </dl>
          {bucket.topModel ? (
            <div className="border-border flex flex-col gap-0.5 border-t pt-2 text-xs">
              <span className="text-muted-foreground">{t('topModel')}</span>
              <span className="text-foreground font-mono break-all">{bucket.topModel}</span>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground text-xs">{t('noRequests')}</p>
      )}
    </div>
  );
}

/**
 * The loaded window at a glance: how many requests, how many failed, the
 * median latency, and when they happened. A bar's red cap is its failed share.
 * Hover or focus a bar for its stats; click it to narrow the list to it.
 */
export function LogHistogram({
  rows,
  live,
  onSelectRange,
}: {
  rows: GatewayLogRow[];
  live: boolean;
  onSelectRange?: (range: LogTimeRange) => void;
}) {
  const t = useTranslations('gatewayLogs');
  const buckets = useMemo(() => bucketLogStats(rows, HISTOGRAM_BUCKETS), [rows]);
  const errors = useMemo(() => rows.filter((r) => !r.ok).length, [rows]);
  const median = useMemo(() => medianLatency(rows), [rows]);
  if (buckets.length === 0) return null;
  const peak = Math.max(1, ...buckets.map((b) => b.total));
  const tickAt = [0, 0.25, 0.5, 0.75].map((f) => Math.floor(f * (HISTOGRAM_BUCKETS - 1)));

  return (
    <section
      aria-label={t('histogram')}
      data-slot="log-histogram"
      className="bg-surface ring-border flex flex-col gap-2 rounded-lg px-4 pt-3.5 pb-2.5 ring-1"
    >
      <div className="flex items-baseline gap-5 tabular-nums">
        <span className="flex items-baseline gap-1.5">
          <span className="text-foreground text-sm font-medium">{rows.length.toLocaleString()}</span>
          <span className="text-muted-foreground text-xs">{t('requestsLabel', { count: rows.length })}</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className={cn('text-sm font-medium', errors > 0 ? 'text-destructive' : 'text-foreground')}>
            {errors.toLocaleString()}
          </span>
          <span className="text-muted-foreground text-xs">{t('errorsLabel', { count: errors })}</span>
        </span>
        {median != null ? (
          <span className="flex items-baseline gap-1.5">
            <span className="text-foreground text-sm font-medium">{fmtLatency(median)}</span>
            <span className="text-muted-foreground text-xs">{t('medianLatency')}</span>
          </span>
        ) : null}
      </div>
      <div className="flex h-14 items-end gap-1.5">
        {buckets.map((b) => (
          <HoverCard key={b.start} openDelay={0} closeDelay={0}>
            <HoverCardTrigger asChild>
              <button
                type="button"
                aria-label={`${fmtRange(b)} · ${t('requestsLabel', { count: b.total })} ${b.total}`}
                onClick={() => onSelectRange?.({ start: b.start, end: b.end })}
                className="group/bar flex h-full min-w-0 flex-1 cursor-pointer items-end outline-none"
              >
                <span
                  className={cn(
                    'flex w-full flex-col overflow-hidden rounded-xs transition-[background-color] duration-(--duration-normal)',
                    b.total
                      ? 'bg-muted-foreground/45 group-hover/bar:bg-foreground/70 group-focus-visible/bar:bg-foreground/70'
                      : 'bg-muted group-hover/bar:bg-muted-foreground/45 group-focus-visible/bar:bg-muted-foreground/45',
                  )}
                  style={{ height: b.total ? `${Math.max(4, (b.total / peak) * 100)}%` : 2 }}
                >
                  {b.errors > 0 ? (
                    <span
                      className="bg-destructive w-full shrink-0"
                      style={{ height: `${Math.max(14, (b.errors / b.total) * 100)}%` }}
                    />
                  ) : null}
                </span>
              </button>
            </HoverCardTrigger>
            <HoverCardContent
              side="bottom"
              align="center"
              sideOffset={6}
              collisionPadding={8}
              animated={false}
              className="w-60 p-3"
            >
              <LogBucketCard bucket={b} />
            </HoverCardContent>
          </HoverCard>
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between text-xs tabular-nums" aria-hidden>
        {tickAt.map((i) => (
          <span key={i}>
            {new Date(buckets[i].start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        ))}
        <span>
          {live
            ? t('now')
            : new Date(buckets[buckets.length - 1].end).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
        </span>
      </div>
    </section>
  );
}

export function GatewayLogs({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const filters = useLocalizedUiCatalog(FILTERS);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [focused, setFocused] = useState(0);
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useGatewayLogs(
    projectId,
    filter === 'all' ? undefined : { ok: filter === 'ok' },
  );
  const t = useTranslations('gatewayLogs');
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<LogTimeRange | null>(null);
  const allLogs = useMemo(() => data?.pages.flatMap((p) => p.logs) ?? [], [data]);
  // The histogram draws the search matches; the list also honours a bar's range.
  const searched = useMemo(
    () => allLogs.filter((row) => matchesLogQuery(row, query)),
    [allLogs, query],
  );
  const logs = useMemo(() => searched.filter((row) => inLogRange(row, range)), [searched, range]);
  // Polling is on only while the newest page is the only page — see the hook.
  const isLive = (data?.pages.length ?? 1) <= 1;

  // Clamp on read rather than in an effect: the live list shrinks under the
  // cursor whenever a page drops rows, and an effect would render once with an
  // out-of-range index before correcting it.
  const focusedIndex = Math.min(focused, Math.max(0, logs.length - 1));

  const focusedRowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    focusedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

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

  const selectedIndex = selectedLogId ? logs.findIndex((l) => l.log_id === selectedLogId) : -1;
  const step = (to: number) => {
    if (to < 0 || to >= logs.length) return;
    setSelectedLogId(logs[to].log_id);
    setFocused(to);
  };
  const counts = filterCounts(filter, allLogs, isLoading);
  // The detail opens in the Models page's own sheet, beside the whole page.
  const renderSheet = useModelsPageSheet(!!selectedLogId, () => setSelectedLogId(null));

  return (
    <>
        <div className="@container/logs flex flex-col gap-5">
          <div className="flex items-center gap-2">
            <div data-slot="log-filter" className="shrink-0">
              <Tabs
                value={filter}
                onValueChange={(v) => {
                  setFilter(v as LogFilter);
                  // Switching filter swaps the whole list, so the cursor goes
                  // back to the top with it — done here, not in an effect.
                  setFocused(0);
                }}
              >
                {/* h-8: the same height as the search field beside it (size xs). */}
                <TabsListCompact aria-label={tI18nComplete.raw('text2dda16fbd512')} className="h-8">
                  {filters.map((f) => (
                    <TabsTriggerCompact key={f.key} value={f.key} className="gap-1.5">
                      {f.label}
                      {/* Counts describe the LOADED window — the route returns
                          pages, never totals — and a tab whose rows are not
                          loaded shows no number rather than a guess. */}
                      {counts[f.key] != null ? (
                        <span className="text-muted-foreground tabular-nums">
                          {counts[f.key]!.toLocaleString()}
                        </span>
                      ) : null}
                    </TabsTriggerCompact>
                  ))}
                </TabsListCompact>
              </Tabs>
            </div>
            <InputGroupSearch className="min-w-0 flex-1">
              <InputGroupSearchIcon>
                <Search />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder={t('searchPlaceholder')}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setFocused(0);
                }}
                size="xs"
              />
              <InputGroupSearchClear onClick={() => setQuery('')} />
            </InputGroupSearch>
            {range ? (
              <Button
                variant="secondary"
                size="sm"
                className="h-8 shrink-0 gap-1.5 tabular-nums"
                onClick={() => setRange(null)}
                aria-label={`${fmtRange(range)} ×`}
              >
                {fmtRange(range)}
                <XIcon className="size-3.5" />
              </Button>
            ) : null}
            {isLive && (
              <span className="text-muted-foreground flex h-8 shrink-0 items-center gap-1.5 pr-1 pl-1.5 text-xs">
                <span className="bg-kortix-green size-1.5 animate-pulse rounded-full" />
                {tI18nComplete.raw('textb64ac05f17e6')}
              </span>
            )}
          </div>

          {searched.length > 0 ? (
            <LogHistogram
              rows={searched}
              live={isLive}
              onSelectRange={(next) => {
                setRange(next);
                setFocused(0);
              }}
            />
          ) : null}

          <div className="flex flex-col">
            {isLoading && logs.length === 0 ? (
              <div className="flex flex-col gap-1">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 rounded-md" />
                ))}
              </div>
            ) : logs.length === 0 && (query.trim() || range) ? (
              <EmptyState
                icon={ScrollText}
                size="sm"
                title={t('noMatch', { query: query.trim() || (range ? fmtRange(range) : '') })}
              />
            ) : logs.length === 0 ? (
              <EmptyState
                icon={ScrollText}
                size="sm"
                title={EMPTY_COPY[filter]}
                description={tI18nComplete.raw('text2aa9d672c950')}
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
                      selected={row.log_id === selectedLogId}
                      onHover={() => setFocused(i)}
                      onClick={() => {
                        setFocused(i);
                        setSelectedLogId(row.log_id);
                      }}
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
                      {tI18nComplete.raw('textac318011a661')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      {renderSheet(
        selectedLogId ? (
          <GatewayLogDetail
            projectId={projectId}
            logId={selectedLogId}
            index={selectedIndex}
            total={logs.length}
            onPrev={() => step(selectedIndex - 1)}
            onNext={() => step(selectedIndex + 1)}
          />
        ) : null,
      )}
    </>
  );
}
