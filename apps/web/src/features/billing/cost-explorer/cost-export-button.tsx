'use client';

import { useState } from 'react';

import {
  fetchCostExportCsv,
  type CostExportResult,
  type ProjectCostExportOptions,
  type SessionCostExportOptions,
} from '@kortix/sdk';

import { Button } from '@/components/ui/button';
import type { CostRange } from '@/components/ui/date-range-picker';
import { IconDownload } from '@/components/ui/kortix-icons';
import Loading from '@/components/ui/loading';
import { errorToast, warningToast } from '@/components/ui/toast';
import { useBillingAccountId } from '@/stores/billing-account-context';

/** Which list route the export runs against — the same discriminant
 *  `fetchCostExportCsv` overloads on. */
export type CostExportKind = 'projects' | 'sessions';

/**
 * The filename the browser saves the download as.
 *
 * A named preset keeps its own token (`last-30d`) rather than being expanded
 * to dates: the preset is what the user picked, it re-reads correctly a week
 * later, and two exports of "last 30 days" taken on different days do not
 * collide under a name that claims to be about a fixed window.
 *
 * A custom range is named by the FIRST AND LAST DAY THE EXPORT INCLUDES —
 * `…-2026-07-01-to-2026-07-07.csv` for the window `[2026-07-01, 2026-07-08)`.
 * The query window is half-open, so its `to` is the exclusive bound and the
 * file contains nothing from that day. Naming the file by the raw bound would
 * claim a day of spend the file does not hold, and would contradict the
 * control that produced it: `formatRangeLabel` prints "Jul 1 – Jul 7, 2026"
 * for that same window. Do not "fix" this back to the raw `to`.
 */
export function buildExportFilename(kind: CostExportKind, range: CostRange): string {
  if (range.preset !== 'custom') return `kortix-${kind}-last-${range.preset}.csv`;

  const from = utcDay(range.from, 'start');
  const to = utcDay(range.to, 'end');
  // `parseExplorerState` (cost-explorer.tsx) takes a custom window's bounds
  // straight from the URL without validating them, so an edited or truncated
  // link can reach here with a string `Date` cannot parse. Reading calendar
  // parts off an Invalid Date yields NaN, which would name the file
  // `kortix-sessions-NaN-NaN-NaN…` — an undated filename is the smaller loss.
  if (from === null || to === null) return `kortix-${kind}-export.csv`;

  return `kortix-${kind}-${from}-to-${to}.csv`;
}

/**
 * `YYYY-MM-DD` for one bound of a custom window, in UTC, or `null` when the
 * value is not a parseable instant.
 *
 * `'end'` names the last day the window INCLUDES, not the raw bound. Only a
 * bound landing exactly on UTC midnight steps back a day: that is the
 * half-open boundary, where the window stops before the day begins. A bound
 * partway through a day (reachable only from a hand-edited URL — the picker's
 * `toUtcDayRange` always emits midnight) still covers part of its own day, so
 * that day is the last one included and must not be stepped back.
 *
 * Every step reads and rebuilds UTC calendar parts, and the result is
 * assembled from those parts rather than from `toISOString()`. `Date.UTC`
 * normalises an out-of-range day — 0 becomes the last day of the previous
 * month, which rolls the year at January — so month and year boundaries need
 * no special-casing.
 */
function utcDay(value: string, bound: 'start' | 'end'): string | null {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;

  const atUtcMidnight =
    instant.getUTCHours() === 0 &&
    instant.getUTCMinutes() === 0 &&
    instant.getUTCSeconds() === 0 &&
    instant.getUTCMilliseconds() === 0;
  const dayDelta = bound === 'end' && atUtcMidnight ? -1 : 0;

  const day = new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() + dayDelta),
  );
  return `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * How many data rows a CSV body holds — records, not physical lines, and not
 * counting the header.
 *
 * `encodeField` (`apps/api/src/shared/cost-csv.ts`) quotes any value holding
 * CR, LF, a comma or a quote, and both `project_name` and `owner` are free
 * text the account's own users control. So a project named with an embedded
 * newline puts a real line break inside a quoted field, and splitting the
 * body on newlines counts that one row twice.
 *
 * Blank records are skipped, so a trailing newline never becomes a row.
 */
export function countCsvDataRows(body: string): number {
  let records = 0;
  let inQuotes = false;
  let recordHasContent = false;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];

    if (inQuotes) {
      // `""` is the escape for a literal quote — consume both and stay inside
      // the field, otherwise the rest of the record is read as unquoted.
      if (char === '"' && body[index + 1] === '"') index += 1;
      else if (char === '"') inQuotes = false;
      recordHasContent = true;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      recordHasContent = true;
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && body[index + 1] === '\n') index += 1;
      if (recordHasContent) records += 1;
      recordHasContent = false;
      continue;
    }

    recordHasContent = true;
  }

  if (recordHasContent) records += 1;
  return Math.max(0, records - 1);
}

/**
 * The truncation warning for an export, or `null` when it was complete.
 *
 * `rowCap` is the CAP VALUE the route reports on every response
 * (`x-kortix-row-cap` = `CSV_ROW_CAP`), not a truncation flag: a 3-row export
 * and a capped one carry the identical header. Truncation is only knowable by
 * comparing the rows actually present against that cap, which is why this
 * takes both.
 *
 * `>=` rather than `===` because the route queries at `limit: CSV_ROW_CAP` and
 * so cannot return more — but if that ever changes, over-reporting must warn
 * rather than fall silent.
 */
export function buildRowCapWarning(rowCount: number, rowCap: number | null): string | null {
  if (rowCap === null || rowCap <= 0) return null;
  if (rowCount < rowCap) return null;
  return `Export capped at ${rowCap.toLocaleString('en-US')} rows. Narrow the date range for a complete export.`;
}

export interface ResolvedCostExport {
  blob: Blob;
  /** The row-cap warning to show, or `null` when the export was complete. */
  warning: string | null;
}

/** Reads the fetched CSV once to decide whether it was truncated, and hands
 *  back the same `Blob` for the download. */
export async function resolveCostExport(result: CostExportResult): Promise<ResolvedCostExport> {
  const rowCount = countCsvDataRows(await result.blob.text());
  return { blob: result.blob, warning: buildRowCapWarning(rowCount, result.rowCap) };
}

/** Saves a blob to the user's machine. Mirrors `downloadFile` in
 *  `features/files/api/runtime-files.ts` — anchor click, then revoke, since
 *  revoking synchronously can race Safari's own read of the URL. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface CostExportButtonViewProps {
  isExporting: boolean;
  onExport: () => void;
}

/** The presentational half — no fetch, no state — so the in-flight rendering
 *  is assertable without driving a click. */
export function CostExportButtonView({ isExporting, onExport }: CostExportButtonViewProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isExporting}
      onClick={onExport}
      aria-label="Export CSV"
    >
      {isExporting ? (
        <Loading className="size-3.5 shrink-0" />
      ) : (
        <IconDownload className="size-3.5 shrink-0" />
      )}
      Export CSV
    </Button>
  );
}

/** Everything the export query needs beyond the window and the account, which
 *  come from `range` and the billing account context. Split per kind so the
 *  compiler rejects a filter the route does not accept — `sort: 'name_asc'`
 *  is valid on the project rollup and a 400 on the session list. */
export type ProjectCostExportFilters = Omit<ProjectCostExportOptions, 'from' | 'to' | 'accountId'>;
export type SessionCostExportFilters = Omit<SessionCostExportOptions, 'from' | 'to' | 'accountId'>;

export type CostExportButtonProps = { range: CostRange } & (
  | { kind: 'projects'; filters?: ProjectCostExportFilters }
  | { kind: 'sessions'; filters?: SessionCostExportFilters }
);

/**
 * The full export query: the level's filters, plus the window and the account
 * the level's own table is already scoped to.
 *
 * `accountId` is not optional-by-omission here. Both export routes resolve an
 * absent `account_id` to the caller's PRIMARY account
 * (`resolveScopedAccountId(c, 'query')`), so on a team account's billing page
 * an export that dropped it would silently return a different account's spend
 * than the table above it. Carrying `undefined` through is correct — the SDK's
 * URL builder omits a falsy `accountId`, which is exactly the
 * "no provider, use the primary account" case.
 */
export function buildCostExportOptions<Filters extends object>(
  range: CostRange,
  accountId: string | undefined,
  filters?: Filters,
): Filters & { accountId: string | undefined; from: string; to: string } {
  return { ...(filters as Filters), accountId, from: range.from, to: range.to };
}

/**
 * Exports the level's whole filtered query as CSV — the server re-runs it at
 * the route's row cap, so the file holds every matching row, not the 25 the
 * table happens to be showing.
 *
 * The download goes through `fetchCostExportCsv`, never a bare `<a href>`:
 * both export routes require a Bearer token and have no `?token=` fallback,
 * so a plain link 401s.
 */
export function CostExportButton(props: CostExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  // Read here rather than passed in: every query on these levels reads the
  // same context, so taking it from the same place is what keeps the export's
  // scope and the table's scope from drifting apart.
  const accountId = useBillingAccountId();

  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      // Branching on `kind` narrows it to a literal, which is what lets the
      // overloaded `fetchCostExportCsv` be called at all — and what makes the
      // per-kind filter type the compiler checks the one for this route.
      const result =
        props.kind === 'projects'
          ? await fetchCostExportCsv(
              'projects',
              buildCostExportOptions(props.range, accountId, props.filters),
            )
          : await fetchCostExportCsv(
              'sessions',
              buildCostExportOptions(props.range, accountId, props.filters),
            );

      const { blob, warning } = await resolveCostExport(result);
      saveBlob(blob, buildExportFilename(props.kind, props.range));
      if (warning) warningToast(warning);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Failed to export CSV');
    } finally {
      setIsExporting(false);
    }
  };

  return <CostExportButtonView isExporting={isExporting} onExport={handleExport} />;
}
