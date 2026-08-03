/**
 * A burst's parts → the one line shown when it is collapsed.
 *
 * Resolution order, per the spec:
 *   1. a reasoning summary (bold heading, else first line)
 *   2. a composed verb phrase from tier-1 parts
 *   3. a neutral fallback
 *
 * No React import.
 */
import { isReasoningPart, type Part } from '@/ui';
import { stepLabel } from './step-label';

const MAX_CLAUSES = 3;
const MAX_TITLE_CHARS = 80;

/** Nouns counted per verb, so "Read 2 files" reads correctly. */
const NOUNS: Record<string, [singular: string, plural: string]> = {
  Read: ['file', 'files'],
  Wrote: ['file', 'files'],
  Edited: ['file', 'files'],
  Ran: ['command', 'commands'],
  Searched: ['time', 'times'],
  Listed: ['directory', 'directories'],
  Fetched: ['page', 'pages'],
  Scraped: ['page', 'pages'],
  Delegated: ['task', 'tasks'],
  Used: ['tool', 'tools'],
};

function reasoningSummary(parts: ReadonlyArray<Part>): string | undefined {
  for (const part of parts) {
    if (!isReasoningPart(part)) continue;
    const text = part.text?.trim();
    if (!text) continue;

    const bold = text.match(/\*\*(.+?)\*\*/);
    if (bold?.[1]) return truncate(bold[1].trim());

    const firstLine = text
      .split('\n')[0]
      .replace(/^#+\s*/, '')
      .trim();
    if (firstLine) return truncate(firstLine);
  }
  return undefined;
}

function truncate(value: string): string {
  return value.length > MAX_TITLE_CHARS ? `${value.slice(0, MAX_TITLE_CHARS - 3)}...` : value;
}

export function burstTitle(parts: ReadonlyArray<Part>, running: boolean): string {
  const summary = reasoningSummary(parts);
  if (summary) return summary;

  // Count tier-1 work only. Plumbing never reaches a collapsed title.
  const counts = new Map<string, number>();
  for (const part of parts) {
    const label = stepLabel(part);
    if (label.tier !== 'primary') continue;
    const key = running ? label.running : label.verb;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (counts.size === 0) {
    const hasPlumbing = parts.some((part) => stepLabel(part).tier === 'plumbing');
    return hasPlumbing ? 'Housekeeping' : 'Worked';
  }

  const entries = [...counts.entries()];
  const shown = entries.slice(0, MAX_CLAUSES);
  const hiddenCount = entries.slice(MAX_CLAUSES).reduce((sum, [, n]) => sum + n, 0);

  const clauses = shown.map(([verb, count], index) => {
    // NOUNS is keyed by past-tense verb; look up via the settled form so the
    // running variant ("Reading") resolves to the same noun pair.
    const pastForm = running ? pastFormOf(verb) : verb;
    const [singular, plural] = NOUNS[pastForm] ?? ['step', 'steps'];
    const noun = count === 1 ? singular : plural;
    const head = index === 0 ? verb : verb.toLowerCase();
    return `${head} ${count} ${noun}`;
  });

  if (hiddenCount > 0) clauses.push(`+${hiddenCount} more`);
  return clauses.join(', ');
}

/** Reverse of StepLabel.running → StepLabel.verb, for noun lookup. */
function pastFormOf(runningVerb: string): string {
  const map: Record<string, string> = {
    Reading: 'Read',
    Writing: 'Wrote',
    Editing: 'Edited',
    Running: 'Ran',
    Searching: 'Searched',
    Listing: 'Listed',
    Fetching: 'Fetched',
    Scraping: 'Scraped',
    Delegating: 'Delegated',
    Using: 'Used',
  };
  return map[runningVerb] ?? runningVerb;
}
