/**
 * One part → the words shown on its row.
 *
 * Tier decides where a row appears, per the spec:
 *   primary   — counted in the burst title, rendered in the burst body
 *   reasoning — supplies the burst title, rendered as a Thinking row
 *   plumbing  — never counted, rendered in the "Behind the scenes" disclosure
 *
 * No React import.
 */
import { humanizeSearchQuery } from '@/features/session/tool/shared/search-query';
import { isReasoningPart, isToolPart, type Part } from '@/ui';
import { normalizeActivityToolName } from '../session-activity-groups';

export type StepTier = 'primary' | 'reasoning' | 'plumbing';

export interface StepLabel {
  /** Past tense, shown when the step has finished. */
  verb: string;
  /** Present participle, shown while the step runs. */
  running: string;
  object?: string;
  tier: StepTier;
}

/**
 * Machine bookkeeping the user never asked for. Always rendered — the spec is
 * "demote everything, hide nothing" — but never counted in a collapsed title.
 */
export const PLUMBING_TOOLS: ReadonlySet<string> = new Set([
  'memory',
  'get_mem',
  'memory_search',
  'dcp_compress',
  'dcp_distill',
  'dcp_prune',
  // The context engine registers these three under their bare names
  // (`tool/tools/dcp-*-tool.tsx` call `ToolRegistry.register('prune'|'distill'|
  // 'compress', …)`), so the `dcp_` spellings above never matched a real part
  // and context compaction was counted as tier-1 work. `narration.ts` already
  // hides the bare names, so without these entries a burst counts a `prune` in
  // its collapsed title and then renders no row for it when expanded.
  'prune',
  'distill',
  'compress',
  'context_info',
]);

interface VerbSpec {
  verb: string;
  running: string;
  /** Input keys to try, in order, for the row's object. */
  objectKeys?: string[];
}

const VERBS: Record<string, VerbSpec> = {
  read: { verb: 'Read', running: 'Reading', objectKeys: ['filePath', 'path', 'file'] },
  write: { verb: 'Wrote', running: 'Writing', objectKeys: ['filePath', 'path', 'file'] },
  edit: { verb: 'Edited', running: 'Editing', objectKeys: ['filePath', 'path', 'file'] },
  apply_patch: { verb: 'Edited', running: 'Editing', objectKeys: ['filePath', 'path'] },
  bash: { verb: 'Ran', running: 'Running', objectKeys: ['command'] },
  glob: { verb: 'Searched', running: 'Searching', objectKeys: ['pattern'] },
  grep: { verb: 'Searched', running: 'Searching', objectKeys: ['pattern'] },
  list: { verb: 'Listed', running: 'Listing', objectKeys: ['path'] },
  web_search: { verb: 'Searched', running: 'Searching', objectKeys: ['query'] },
  websearch: { verb: 'Searched', running: 'Searching', objectKeys: ['query'] },
  webfetch: { verb: 'Fetched', running: 'Fetching', objectKeys: ['url'] },
  web_fetch: { verb: 'Fetched', running: 'Fetching', objectKeys: ['url'] },
  scrape: { verb: 'Scraped', running: 'Scraping', objectKeys: ['url'] },
  scrape_webpage: { verb: 'Scraped', running: 'Scraping', objectKeys: ['url'] },
  task: { verb: 'Delegated', running: 'Delegating', objectKeys: ['description'] },
  memory: { verb: 'Remembered', running: 'Remembering' },
  get_mem: { verb: 'Recalled', running: 'Recalling' },
  memory_search: { verb: 'Recalled', running: 'Recalling', objectKeys: ['query'] },
  dcp_compress: { verb: 'Compacted', running: 'Compacting' },
  dcp_distill: { verb: 'Distilled', running: 'Distilling' },
  dcp_prune: { verb: 'Pruned', running: 'Pruning' },
  // The names the context engine actually registers — see PLUMBING_TOOLS. An
  // unknown tool short-circuits to a generic primary label before the plumbing
  // set is ever consulted, so a spec here is what makes the tier stick.
  compress: { verb: 'Compacted', running: 'Compacting' },
  distill: { verb: 'Distilled', running: 'Distilling' },
  prune: { verb: 'Pruned', running: 'Pruning' },
  context_info: { verb: 'Checked context', running: 'Checking context' },
};

/**
 * A file path renders as its basename, a search query drops its engine
 * operators, and anything else renders whole.
 *
 * Both are the same rule: the row shows what was worked ON, not the argument
 * the tool was handed. `Searched site:daytona.io Daytona sandboxes` reads as a
 * bug for the same reason `Read /a/b/c/d/package.json` reads as noise.
 */
function shorten(key: string, value: string): string {
  if (key === 'filePath' || key === 'path' || key === 'file') {
    const segments = value.split('/');
    return segments[segments.length - 1] || value;
  }
  if (key === 'query') return humanizeSearchQuery(value) || value;
  return value;
}

function readObject(input: unknown, keys: string[] | undefined): string | undefined {
  if (!keys || typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return shorten(key, value.trim());
  }
  return undefined;
}

export function stepLabel(part: Part): StepLabel {
  if (isReasoningPart(part)) {
    return { verb: 'Thought', running: 'Thinking', object: undefined, tier: 'reasoning' };
  }

  if (!isToolPart(part)) {
    return { verb: 'Used', running: 'Using', object: undefined, tier: 'primary' };
  }

  const name = normalizeActivityToolName(part.tool);
  const spec = VERBS[name];
  const input = (part.state as { input?: unknown } | undefined)?.input;

  // Unknown tools are labelled generically rather than dropped. Silent loss is
  // worse than an ugly row.
  if (!spec) {
    return { verb: 'Used', running: 'Using', object: name, tier: 'primary' };
  }

  return {
    verb: spec.verb,
    running: spec.running,
    object: readObject(input, spec.objectKeys),
    tier: PLUMBING_TOOLS.has(name) ? 'plumbing' : 'primary',
  };
}
