/**
 * The page list agents receive (pure, plus a render cache): per layer, the
 * confirmed pages by type in table order, newest first, one line each:
 * `- <title> — <summary> (<copy path>)`. A thread's list fits ≈2,000 tokens:
 * Company ≤ 3,000 chars, the other layers share 5,000, and a layer may use
 * budget another leaves unused. Over budget, the oldest lines of the largest
 * type go first and the layer ends with a line that names `memory_search`.
 */
import type { MemoryPageStatus, MemoryPageType } from '@kortix/api-contract';

const TYPE_ORDER: readonly MemoryPageType[] = ['people', 'decisions', 'workstreams', 'playbooks', 'note'];
const HEADINGS: Record<MemoryPageType, string> = {
  people: 'People',
  decisions: 'Decisions',
  workstreams: 'Workstreams',
  playbooks: 'Playbooks',
  note: 'Notes to file',
};
export const INDEX_BUDGET = { total: 8_000, company: 3_000, others: 5_000 } as const;

export interface IndexPage {
  type: MemoryPageType;
  title: string;
  summary: string;
  status: MemoryPageStatus;
  updatedAt: Date;
  /** The page's file in the copy. */
  path: string;
}

export interface IndexGroup {
  type: MemoryPageType;
  /** Newest first. */
  lines: string[];
}

const pageLine = (page: IndexPage) => {
  const title = page.title.replace(/\s+/g, ' ').trim();
  const summary = page.summary.replace(/\s+/g, ' ').trim();
  return `- ${title}${summary ? ` — ${summary}` : ''} (${page.path})`;
};

/** The confirmed pages of one layer as groups in type order, each newest first. */
export function indexGroups(pages: readonly IndexPage[]): IndexGroup[] {
  return TYPE_ORDER.map((type) => ({
    type,
    lines: pages
      .filter((page) => page.type === type && page.status === 'confirmed')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(pageLine),
  })).filter((group) => group.lines.length > 0);
}

const overflowLine = (n: number) => `- …and ${n} more page${n === 1 ? '' : 's'}: use memory_search.`;

function joinGroups(groups: readonly IndexGroup[], dropped: number): string {
  const text = groups
    .filter((group) => group.lines.length > 0)
    .map((group) => `## ${HEADINGS[group.type]}\n${group.lines.join('\n')}`)
    .join('\n\n');
  return dropped > 0 ? `${text}${text ? '\n' : ''}${overflowLine(dropped)}` : text;
}

/** One layer's list, cut to `budget` characters (no cut by default). */
export function renderIndex(groups: readonly IndexGroup[], budget = Number.POSITIVE_INFINITY): string {
  const kept = groups.map((group) => ({ type: group.type, lines: [...group.lines] }));
  let dropped = 0;
  let text = joinGroups(kept, 0);
  while (text.length > budget) {
    const largest = kept.reduce((a, b) => (b.lines.length > a.lines.length ? b : a), kept[0]!);
    if (!largest || largest.lines.length === 0) break;
    largest.lines.pop();
    dropped += 1;
    text = joinGroups(kept, dropped);
  }
  return text;
}

/**
 * Character budgets per layer: Company 3,000, the other layers 5,000 split
 * evenly; budget a layer does not need goes to the layers that need more, in
 * order.
 */
export function splitBudget(layers: readonly { scope: 'company' | 'channel' | 'dm'; need: number }[]): number[] {
  const others = layers.filter((layer) => layer.scope !== 'company').length;
  const base = layers.map((layer) =>
    layer.scope === 'company' ? INDEX_BUDGET.company : Math.floor(INDEX_BUDGET.others / Math.max(others, 1)),
  );
  let spare = layers.reduce((sum, layer, i) => sum + Math.max(0, base[i]! - layer.need), 0);
  if (!layers.some((layer) => layer.scope === 'company')) spare += INDEX_BUDGET.company;
  if (others === 0) spare += INDEX_BUDGET.others;
  return layers.map((layer, i) => {
    if (layer.need <= base[i]!) return base[i]!;
    const extra = Math.min(spare, layer.need - base[i]!);
    spare -= extra;
    return base[i]! + extra;
  });
}

const CACHE_MAX = 5_000;
// replica-local: rendered index text per (layer, version); a version bump makes a new key, so entries never go stale.
const cache = new Map<string, string>();

/** The rendered text of a layer at a version, from the cache when this replica rendered it before. */
export function cachedIndex(layerId: string, version: number | string, render: () => string): string {
  const key = `${layerId}:${version}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const text = render();
  cache.set(key, text);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return text;
}
