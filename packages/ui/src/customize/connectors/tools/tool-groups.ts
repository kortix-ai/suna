import type { UiTranslator } from '../../../i18n';
import type { ConnectorAction } from '@kortix/sdk';

export interface ToolGroup {
  key: 'read' | 'write';
  label: string;
  actions: ConnectorAction[];
}

/**
 * Two buckets, because that is the only distinction a non-technical reader
 * needs before granting access: can this look at my data, or change it.
 * `destructive` folds into writes — a delete is a write with worse consequences,
 * and a third bucket would just make the safe/unsafe line harder to see.
 *
 * An empty bucket is omitted rather than rendered as a heading over nothing.
 * Input order is kept inside each bucket: that is the order the connector
 * reports its tools in, which is the order its own docs use.
 */
export function groupToolsByRisk(
  actions: readonly ConnectorAction[],
  tI18nComplete: UiTranslator,
): ToolGroup[] {
  const read = actions.filter((a) => a.risk === 'read');
  const write = actions.filter((a) => a.risk !== 'read');
  const groups: ToolGroup[] = [];
  if (read.length)
    groups.push({ key: 'read', label: tI18nComplete.raw('textdd28b5cb26fd'), actions: read });
  if (write.length)
    groups.push({ key: 'write', label: tI18nComplete.raw('texted26c1af81cf'), actions: write });
  return groups;
}

export interface ToolRowText {
  /** The row's heading, in words: `LINEAR_ARCHIVE_ISSUE` reads "Archive issue". */
  title: string;
  /** The tool path, or `null` when the title already IS the path. */
  path: string | null;
  /** The description, or `null` when it only repeats the title. */
  description: string | null;
}

/**
 * What one row prints, with nothing said twice.
 *
 * An OpenAPI connector commonly derives both `name` and `description` from the
 * same `summary` — the live `petstore` fixture does for all 19 of its tools —
 * so a naive row renders "Deletes a pet." over "Deletes a pet." The path is
 * dropped the same way when the title is the path itself.
 *
 * `appNames` are the connector's slug and names: a title drops the one it
 * starts with, because every row on the page already belongs to that app.
 */
export function toolRowText(
  action: ConnectorAction,
  appNames: readonly string[] = [],
): ToolRowText {
  const name = action.name?.trim();
  const description = action.description?.trim();
  const title = humanizeToolName(name || action.path, appNames);
  const same = (value: string | undefined) =>
    Boolean(value) && value!.toLowerCase() === title.toLowerCase();
  return {
    title,
    path: title === action.path ? null : action.path,
    description: !description || same(description) ? null : description,
  };
}

const IDENTIFIER = /^[A-Za-z0-9_.\-/:]+$/;
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A tool id as a sentence-case title. `LINEAR_ARCHIVE_ISSUE` with app name
 * `linear` reads "Archive issue"; `ask_wiki_question` reads "Ask wiki
 * question"; `getPetById` reads "Get pet by id".
 *
 * Only an identifier is rewritten. A name with a space is the connector's own
 * wording and stays as it is. A prefix is dropped only when words remain.
 */
export function humanizeToolName(name: string, appNames: readonly string[] = []): string {
  const trimmed = name.trim();
  if (!IDENTIFIER.test(trimmed)) return trimmed;
  const words = trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.\-/:]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return trimmed;
  const apps = new Set(appNames.map(normalize).filter(Boolean));
  // Up to three words: `GOOGLE_SHEETS_ADD_ROW` with app `googlesheets`.
  for (let take = Math.min(3, words.length - 1); take > 0; take--) {
    if (apps.has(words.slice(0, take).join(''))) {
      words.splice(0, take);
      break;
    }
  }
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Narrow a tool list by a free-text query. A connector with 60 tools is
 * unusable without one.
 *
 * Matches the path, the display name and the description, because a reader
 * looking for "the one that sends mail" knows the words in the description
 * long before they know `messages.send`. An all-whitespace query is not a
 * query — returning nothing for a stray space would read as "this connector
 * has no tools", which is a different and much worse claim.
 */
export function filterActions(
  actions: readonly ConnectorAction[],
  query: string,
): ConnectorAction[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...actions];
  return actions.filter((a) =>
    `${a.path} ${a.name} ${a.description ?? ''}`.toLowerCase().includes(needle),
  );
}
