import {
  craftReportById,
  craftReportsByRecency,
  type CraftReport,
  type CraftRun,
} from './craft-runs';
import { CRAFTS, type Craft } from './crafts-catalog';

/**
 * Joins a craft run report to its catalog entry.
 *
 * This module is CLIENT-GRAPH ONLY. It imports `crafts-catalog`, which imports
 * icon VALUES from `@phosphor-icons/react` — a `createContext` call at module
 * scope that crashes the build if it reaches a server component. Server code
 * that only needs to know whether a report EXISTS imports `craftReportById`
 * from `craft-runs` instead, which carries no catalog dependency.
 */
export interface CraftReportEntry {
  craft: Craft;
  report: CraftReport;
  /** `report.runs[0]` — every surface needs it, none should re-index for it. */
  latest: CraftRun;
}

/**
 * Reports joined to their craft, most recently run first. A report whose
 * `craftId` is not in the catalog is dropped rather than rendered as a blank
 * row — the mock and the catalog are two files and they can drift.
 */
export function craftReportEntries(): CraftReportEntry[] {
  return craftReportsByRecency().flatMap((report) => {
    const craft = CRAFTS.find((item) => item.id === report.craftId);
    const latest = report.runs[0];
    if (!craft || !latest) return [];
    return [{ craft, report, latest }];
  });
}

/** One entry by craft id, or `null` when either half is missing. */
export function craftReportEntry(craftId: string): CraftReportEntry | null {
  const report = craftReportById(craftId);
  const craft = CRAFTS.find((item) => item.id === craftId);
  const latest = report?.runs[0];
  if (!report || !craft || !latest) return null;
  return { craft, report, latest };
}
