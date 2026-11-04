/* Pure week math for the weekly changelog. No `@/` or Next imports, so a Bun
 * script can import it as well as the page.
 *
 * A week is an ISO 8601 week in UTC: Monday 00:00:00.000Z (inclusive) to the
 * next Monday (exclusive), named `YYYY-Www`. A release belongs to the week of
 * its `published_at`, the moment it went live in prod. */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** A closed week has had 6 h to settle, so a release published late on a
 *  Sunday is in before anything summarises the week. */
const SETTLE_MS = 6 * 3_600_000;

const WEEK_ID = /^(\d{4})-W(\d{2})$/;

export interface WeekWindow {
  /** `2026-W42`. */
  id: string;
  start: Date;
  end: Date;
}

/** Monday 00:00Z of the week that contains `ms`. */
function mondayOf(ms: number): number {
  const day = Math.floor(ms / DAY_MS);
  // 1970-01-01 was a Thursday: day 0 → weekday index 3 (Mon = 0).
  return (day - ((day + 3) % 7)) * DAY_MS;
}

export function isoWeekId(date: Date): string {
  // The ISO year is the year of the week's Thursday.
  const thursday = new Date(mondayOf(date.getTime()) + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / WEEK_MS);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function weekWindow(id: string): WeekWindow {
  const match = WEEK_ID.exec(id);
  if (match) {
    // January 4 is always in week 1.
    const start = mondayOf(Date.UTC(Number(match[1]), 0, 4)) + (Number(match[2]) - 1) * WEEK_MS;
    if (isoWeekId(new Date(start)) === id) {
      return { id, start: new Date(start), end: new Date(start + WEEK_MS) };
    }
  }
  throw new Error(`invalid week id: ${id}`);
}

export function isClosed(window: WeekWindow, now: Date): boolean {
  return now.getTime() >= window.end.getTime() + SETTLE_MS;
}

export interface WeekGroup<T> {
  window: WeekWindow;
  /** Newest first. */
  releases: T[];
}

/** Newest week first. A release with no `published_at` never went live and is dropped. */
export function groupByWeek<T extends { published_at: string | null }>(
  releases: readonly T[],
): WeekGroup<T>[] {
  const groups = new Map<string, T[]>();
  const sorted = releases
    .filter((r) => r.published_at)
    .sort((a, b) => b.published_at!.localeCompare(a.published_at!));
  for (const release of sorted) {
    const id = isoWeekId(new Date(release.published_at!));
    groups.set(id, [...(groups.get(id) ?? []), release]);
  }
  return [...groups].map(([id, items]) => ({ window: weekWindow(id), releases: items }));
}

export interface ReleaseSections {
  /** One bullet's markdown each, without its leading `- ` or `* `. */
  new: string[];
  improved: string[];
  fixed: string[];
}

// Release notes open with New / Improved / Fixed as `###` (v0.13.53 on),
// `##` (v0.13.20 on) or `**New**` (v0.12), then GitHub's generated
// `## What's Changed` PR list. Some hotfix notes have no section at all.
const SECTION_HEADING = /^(?:#{2,3}\s+(New|Improved|Fixed)|\*\*(New|Improved|Fixed)\*\*)\s*$/i;
const BULLET = /^[-*]\s+(.*)$/;

export function parseSections(body: string | null): ReleaseSections {
  const sections: ReleaseSections = { new: [], improved: [], fixed: [] };
  let current: string[] | null = null;
  for (const line of (body ?? '').split(/\r?\n/)) {
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      current = sections[(heading[1] ?? heading[2]).toLowerCase() as keyof ReleaseSections];
      continue;
    }
    if (line.startsWith('#')) {
      current = null;
      continue;
    }
    if (!current) continue;
    const bullet = BULLET.exec(line);
    if (bullet) current.push(bullet[1].trim());
    else if (/^\s+\S/.test(line) && current.length > 0) {
      current[current.length - 1] += ` ${line.trim()}`;
    }
  }
  return sections;
}

/** Highlights per week on `/changelog`. The rest is a count line. */
export const WEEKLY_HIGHLIGHT_COUNT = 5;

// `**One credits plan.** Every account…` — release authors lead a headline
// feature with a bold title that ends in `.` or `:`. A bold phrase that runs
// on into the sentence (`**Pin sessions** to keep…`) is not a title.
const BOLD_LEAD = /^\*\*(.+?)([.:])?\*\*\s*(.*)$/;

export function splitLead(bullet: string): { title: string | null; body: string } {
  const match = BOLD_LEAD.exec(bullet);
  if (!match || (!match[2] && match[3])) return { title: null, body: bullet };
  return { title: match[1].trim(), body: match[3].trim() };
}

/**
 * The week's headline features from each release's New bullets, newest
 * release first. Bold-titled bullets are the ones the author chose to lead
 * with; a release without any offers its plain bullets. Releases take turns
 * (the one with the most New items first), so one large release cannot
 * crowd the others out, and each author's order is kept.
 */
export function pickHighlights(
  newByRelease: readonly string[][],
  max: number = WEEKLY_HIGHLIGHT_COUNT,
): string[] {
  const queues = newByRelease
    .map((bullets, order) => {
      const titled = bullets.filter((b) => splitLead(b).title !== null);
      return { size: bullets.length, order, queue: titled.length > 0 ? titled : [...bullets] };
    })
    .sort((a, b) => b.size - a.size || a.order - b.order)
    .map((r) => r.queue);
  const picked: string[] = [];
  for (let round = 0; picked.length < max && queues.some((q) => q.length > round); round++) {
    for (const queue of queues) {
      if (picked.length < max && round < queue.length) picked.push(queue[round]);
    }
  }
  return picked;
}

/** `/changelog/<slug>` for a week: its Monday as `YYYY-MM-DD` (2026-W43 →
 *  `2026-10-19`). A date never changes once the week exists, unlike a slug
 *  made from the week's headline, which moves when a bigger release lands. */
export function weekSlug(window: WeekWindow): string {
  return window.start.toISOString().slice(0, 10);
}
