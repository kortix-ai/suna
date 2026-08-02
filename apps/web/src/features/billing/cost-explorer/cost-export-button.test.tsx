import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { formatRangeLabel, resolvePreset } from '@/components/ui/date-range-picker';

import {
  CostExportButtonView,
  buildCostExportOptions,
  buildExportFilename,
  buildRowCapWarning,
  countCsvDataRows,
  resolveCostExport,
} from './cost-export-button';

/** Builds a CSV in the exact shape `toCsv` emits (`apps/api/src/shared/cost-csv.ts`):
 *  one header line, then one line per row, joined with CRLF and with no
 *  trailing newline. */
function csv(...rows: string[]): string {
  return ['session_id,total_cost_usd', ...rows].join('\r\n');
}

function csvBlob(text: string): Blob {
  return new Blob([text], { type: 'text/csv; charset=utf-8' });
}

function plainRows(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `s${index},1.00`);
}

describe('buildExportFilename', () => {
  test('names the file by scope and the days the export includes', () => {
    // `to` is the EXCLUSIVE bound of the half-open query window, so this file
    // holds spend through the 7th and nothing from the 8th. The name says so.
    expect(
      buildExportFilename('sessions', {
        preset: 'custom',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-08T00:00:00.000Z',
      }),
    ).toBe('kortix-sessions-2026-07-01-to-2026-07-07.csv');
  });

  test('names the same last day the range picker labels for that window', () => {
    // The cross-surface lock. A user picks "Jul 1 – Jul 7" and must receive a
    // file that says Jul 7 — two surfaces disagreeing under one label is the
    // defect this naming exists to avoid.
    const range = {
      preset: 'custom' as const,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
    };
    expect(formatRangeLabel(range)).toBe('Jul 1 – Jul 7, 2026');
    expect(buildExportFilename('sessions', range)).toContain('to-2026-07-07');
  });

  test('steps back across a month boundary', () => {
    // `to` on the 1st means the export stops at the end of the previous
    // month. Day arithmetic that does not normalise would produce `-08-00`.
    expect(
      buildExportFilename('projects', {
        preset: 'custom',
        from: '2026-07-25T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
      }),
    ).toBe('kortix-projects-2026-07-25-to-2026-07-31.csv');
  });

  test('steps back across a year boundary', () => {
    expect(
      buildExportFilename('sessions', {
        preset: 'custom',
        from: '2026-12-25T00:00:00.000Z',
        to: '2027-01-01T00:00:00.000Z',
      }),
    ).toBe('kortix-sessions-2026-12-25-to-2026-12-31.csv');
  });

  test('does not step back a bound that lands partway through a day', () => {
    // Only a UTC-midnight `to` is the half-open boundary where the window
    // stops before the day begins. A `to` of 23:00Z still covers most of its
    // own day, so the 7th IS the last day included. Reachable only from a
    // hand-edited URL — `toUtcDayRange` always emits midnight.
    expect(
      buildExportFilename('sessions', {
        preset: 'custom',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-07T23:00:00.000Z',
      }),
    ).toBe('kortix-sessions-2026-07-01-to-2026-07-07.csv');
  });

  test('reads the last included day in UTC, not in the host timezone', () => {
    // Asserted on the produced string, so it holds under every TZ this file is
    // run in (see the TZ matrix in the task report). Under a negative UTC
    // offset, 2026-07-08T00:00:00Z is still the 7th locally, so a
    // local-calendar-parts implementation would step back to the 6th here.
    expect(
      buildExportFilename('projects', {
        preset: 'custom',
        from: '2026-07-08T00:00:00.000Z',
        to: '2026-07-09T00:00:00.000Z',
      }),
    ).toBe('kortix-projects-2026-07-08-to-2026-07-08.csv');
  });

  test('uses the preset token when one is set', () => {
    expect(
      buildExportFilename('projects', resolvePreset('30d', new Date('2026-08-01T00:00:00.000Z'))),
    ).toBe('kortix-projects-last-30d.csv');
  });

  test('carries every preset token, not just 30d', () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    expect(buildExportFilename('sessions', resolvePreset('24h', now))).toBe(
      'kortix-sessions-last-24h.csv',
    );
    expect(buildExportFilename('sessions', resolvePreset('7d', now))).toBe(
      'kortix-sessions-last-7d.csv',
    );
    expect(buildExportFilename('projects', resolvePreset('90d', now))).toBe(
      'kortix-projects-last-90d.csv',
    );
  });

  test('normalises a custom bound that is not already a UTC ISO instant', () => {
    // A custom range's from/to come straight off the URL (`parseExplorerState`
    // in cost-explorer.tsx reads `params.get('from')` unvalidated), so they are
    // not guaranteed to be the `Z`-suffixed strings `toUtcDayRange` produces.
    // 2026-07-01T01:00:00+02:00 is 2026-06-30T23:00:00Z, so the UTC day is the
    // 30th — a plain `.slice(0, 10)` on the raw string would name it the 1st.
    expect(
      buildExportFilename('sessions', {
        preset: 'custom',
        from: '2026-07-01T01:00:00+02:00',
        to: '2026-07-08T00:00:00.000Z',
      }),
    ).toBe('kortix-sessions-2026-06-30-to-2026-07-07.csv');
  });

  test('falls back to an undated name rather than an NaN-filled one on an unparseable bound', () => {
    // Reading UTC calendar parts off an Invalid Date yields NaN, which would
    // otherwise name the file `kortix-projects-NaN-NaN-NaN-to-…` for a URL
    // nobody can fix from the UI.
    expect(
      buildExportFilename('projects', { preset: 'custom', from: 'not-a-date', to: 'also-bad' }),
    ).toBe('kortix-projects-export.csv');
  });
});

describe('buildCostExportOptions', () => {
  const range = {
    preset: 'custom' as const,
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-08T00:00:00.000Z',
  };

  test('carries the window, the account and the level filters', () => {
    expect(
      buildCostExportOptions(range, 'acc_1', { projectId: 'p_1', sort: 'recent' as const }),
    ).toEqual({
      projectId: 'p_1',
      sort: 'recent',
      accountId: 'acc_1',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
    });
  });

  test('carries the account even for a level that passes no filters at all', () => {
    // Both export routes resolve an absent account_id to the caller's PRIMARY
    // account (`resolveScopedAccountId(c, 'query')`), so on a team billing
    // page a dropped accountId exports a different account's spend than the
    // table above it.
    expect(buildCostExportOptions(range, 'acc_team').accountId).toBe('acc_team');
  });

  test('keeps an unresolved account as undefined rather than inventing one', () => {
    // Outside a BillingAccountProvider `useBillingAccountId()` is undefined,
    // which the SDK's URL builder omits — the primary-account default, chosen
    // deliberately rather than by accident.
    expect(buildCostExportOptions(range, undefined, { sort: 'total_desc' as const })).toEqual({
      sort: 'total_desc',
      accountId: undefined,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
    });
  });

  test('takes the window from the range, not from the filters', () => {
    const options = buildCostExportOptions({ preset: '7d', from: 'FROM', to: 'TO' }, 'acc_1', {
      sort: 'total_desc' as const,
    });
    expect(options.from).toBe('FROM');
    expect(options.to).toBe('TO');
  });
});

describe('countCsvDataRows', () => {
  test('does not count the header as a data row', () => {
    expect(countCsvDataRows(csv())).toBe(0);
  });

  test('counts one row per record', () => {
    expect(countCsvDataRows(csv(...plainRows(3)))).toBe(3);
  });

  test('an empty body is zero rows', () => {
    expect(countCsvDataRows('')).toBe(0);
  });

  test('a CRLF inside a quoted field stays part of its own row', () => {
    // `encodeField` quotes any value containing CR, LF, comma or quote, and
    // project_name / owner are free text the account's own users control — so
    // a physical-line count over-reports every row whose project name has a
    // newline in it. Two records here, across three physical lines.
    const body = csv('s0,"line one\r\nline two"', 's1,1.00');
    expect(body.split('\r\n').length).toBe(4);
    expect(countCsvDataRows(body)).toBe(2);
  });

  test('a doubled quote inside a quoted field does not end the field', () => {
    // "" is `encodeField`'s escape for a literal quote. Treating the first of
    // the pair as the field terminator would leave the counter outside quotes
    // for the rest of the record.
    expect(countCsvDataRows(csv('s0,"he said ""hi""\r\nstill the same row"'))).toBe(1);
  });

  test('a trailing newline does not invent a row', () => {
    // `toCsv` never emits one, so this is defensive rather than observed.
    expect(countCsvDataRows(`${csv(...plainRows(2))}\r\n`)).toBe(2);
  });

  test('counts LF-only records too', () => {
    // Also defensive: `toCsv` joins with CRLF today. Asserted because the
    // counter claims to handle bare LF, and an untested claim is not a claim.
    expect(countCsvDataRows('session_id,total_cost_usd\ns0,1.00\ns1,2.00')).toBe(2);
  });
});

describe('buildRowCapWarning', () => {
  // `rowCap` is the CAP VALUE the route always reports (CSV_ROW_CAP, currently
  // 10000), not a truncation flag — it comes back identical on a 3-row export
  // and on a capped one. Truncation is only visible by comparing the rows
  // actually present against that cap.
  test('stays silent below the cap', () => {
    expect(buildRowCapWarning(9_999, 10_000)).toBeNull();
  });

  test('warns once the rows reach the cap', () => {
    expect(buildRowCapWarning(10_000, 10_000)).toBe(
      'Export capped at 10,000 rows. Narrow the date range for a complete export.',
    );
  });

  test('reports the cap the response carried, not a hardcoded 10,000', () => {
    expect(buildRowCapWarning(500, 500)).toBe(
      'Export capped at 500 rows. Narrow the date range for a complete export.',
    );
  });

  test('stays silent when the header was absent or unparseable', () => {
    // `fetchCostExportCsv` yields `rowCap: null` for a missing or non-numeric
    // x-kortix-row-cap. With no cap to compare against there is nothing
    // truthful to say, so it says nothing.
    expect(buildRowCapWarning(10_000, null)).toBeNull();
  });

  test('an empty export never warns', () => {
    // Guards a nonsensical cap of 0, where `rowCount >= rowCap` would
    // otherwise fire on every export including a zero-row one.
    expect(buildRowCapWarning(0, 0)).toBeNull();
  });
});

describe('resolveCostExport', () => {
  test('passes the blob through untouched', async () => {
    const blob = csvBlob(csv(...plainRows(2)));
    const resolved = await resolveCostExport({ blob, rowCap: 25 });
    expect(resolved.blob).toBe(blob);
  });

  test('is silent one row below the cap and warns exactly at it', async () => {
    const below = await resolveCostExport({ blob: csvBlob(csv(...plainRows(24))), rowCap: 25 });
    expect(below.warning).toBeNull();

    const atCap = await resolveCostExport({ blob: csvBlob(csv(...plainRows(25))), rowCap: 25 });
    expect(atCap.warning).toBe(
      'Export capped at 25 rows. Narrow the date range for a complete export.',
    );
  });

  test('judges truncation on records, not physical lines', async () => {
    // 24 records, one of which spans two physical lines — 25 lines of body
    // under a cap of 25. A line-based count would report this untruncated
    // export as capped.
    const body = csv('s0,"line one\r\nline two"', ...plainRows(23));
    expect(body.split('\r\n').length).toBe(26);
    const resolved = await resolveCostExport({ blob: csvBlob(body), rowCap: 25 });
    expect(resolved.warning).toBeNull();
  });
});

describe('CostExportButtonView', () => {
  test('renders an outline button labelled Export CSV', () => {
    const html = renderToStaticMarkup(
      <CostExportButtonView isExporting={false} onExport={() => {}} />,
    );
    expect(html).toContain('Export CSV');
    // The attribute, not the bare word — Button's base class carries
    // `disabled:pointer-events-none` on every render, disabled or not.
    expect(html).not.toContain('disabled=""');
  });

  test('disables itself and shows the Loading primitive while in flight', () => {
    const html = renderToStaticMarkup(<CostExportButtonView isExporting onExport={() => {}} />);
    expect(html).toContain('disabled=""');
    // `Loading`'s orbit variant — the codebase's only spinner. An icon with
    // `animate-spin` is banned by the design system.
    expect(html).toContain('animate-spinner-orbit');
  });
});
