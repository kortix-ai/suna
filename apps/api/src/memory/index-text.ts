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
  pageId: string;
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
  /** The page of each line. */
  pageIds: string[];
}

const pageLine = (page: IndexPage) => {
  const title = page.title.replace(/\s+/g, ' ').trim();
  const summary = page.summary.replace(/\s+/g, ' ').trim();
  return `- ${title}${summary ? ` — ${summary}` : ''} (${page.path})`;
};

/** The confirmed pages of one layer as groups in type order, each newest first. */
export function indexGroups(pages: readonly IndexPage[]): IndexGroup[] {
  return TYPE_ORDER.map((type) => {
    const listed = pages
      .filter((page) => page.type === type && page.status === 'confirmed')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return { type, lines: listed.map(pageLine), pageIds: listed.map((page) => page.pageId) };
  }).filter((group) => group.lines.length > 0);
}

const overflowLine = (n: number) => `- …and ${n} more page${n === 1 ? '' : 's'}: use memory_search.`;

function joinGroups(groups: readonly IndexGroup[], dropped: number): string {
  const text = groups
    .filter((group) => group.lines.length > 0)
    .map((group) => `## ${HEADINGS[group.type]}\n${group.lines.join('\n')}`)
    .join('\n\n');
  return dropped > 0 ? `${text}${text ? '\n' : ''}${overflowLine(dropped)}` : text;
}

/** The length `joinGroups` would produce, from per-group line counts and character sums (no string is built). */
function joinedLength(groups: readonly { type: MemoryPageType; count: number; chars: number }[], dropped: number): number {
  const live = groups.filter((group) => group.count > 0);
  const text = live.reduce((sum, g) => sum + `## ${HEADINGS[g.type]}\n`.length + g.chars + g.count - 1, 0) + 2 * Math.max(live.length - 1, 0);
  return dropped > 0 ? text + (text > 0 ? 1 : 0) + overflowLine(dropped).length : text;
}

/** One layer's list cut to `budget` characters, and the pages it still lists. */
export function cutIndex(groups: readonly IndexGroup[], budget = Number.POSITIVE_INFINITY): { text: string; pageIds: string[] } {
  const sizes = groups.map((group) => ({ type: group.type, count: group.lines.length, chars: group.lines.reduce((n, line) => n + line.length, 0) }));
  let dropped = 0;
  while (joinedLength(sizes, dropped) > budget) {
    const largest = sizes.reduce((a, b) => (b.count > a.count ? b : a), sizes[0]!);
    if (!largest || largest.count === 0) break;
    largest.count -= 1;
    largest.chars -= groups[sizes.indexOf(largest)]!.lines[largest.count]!.length;
    dropped += 1;
  }
  const kept = groups.map((group, i) => ({ type: group.type, lines: group.lines.slice(0, sizes[i]!.count), pageIds: group.pageIds.slice(0, sizes[i]!.count) }));
  return { text: joinGroups(kept, dropped), pageIds: kept.flatMap((group) => group.pageIds) };
}

/** One layer's list, cut to `budget` characters (no cut by default). */
export const renderIndex = (groups: readonly IndexGroup[], budget?: number): string => cutIndex(groups, budget).text;

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

const CACHE_MAX_BYTES = 32 * 1024 * 1024;
// replica-local: one rendered index per layer key, at the version it was rendered for; a newer version replaces it. LRU, bounded by size.
const cache = new Map<string, { version: string; value: unknown; bytes: number }>();
let cacheBytes = 0;

/** Rough UTF-16 size of a cached value. */
const sizeOf = (value: unknown) => 2 * (typeof value === 'string' ? value.length : JSON.stringify(value).length);

/** The cached value of a layer at a version (marked recently used), or undefined. */
export function peekIndex<T>(layerId: string, version: number | string): T | undefined {
  const hit = cache.get(layerId);
  if (!hit || hit.version !== String(version)) return undefined;
  cache.delete(layerId);
  cache.set(layerId, hit);
  return hit.value as T;
}

/** The rendered index of a layer at a version, from the cache when this replica rendered it before. */
export function cachedIndex<T>(layerId: string, version: number | string, render: () => T): T {
  const hit = peekIndex<T>(layerId, version);
  if (hit !== undefined) return hit;
  const value = render();
  const old = cache.get(layerId);
  if (old) {
    cache.delete(layerId);
    cacheBytes -= old.bytes;
  }
  const entry = { version: String(version), value, bytes: sizeOf(value) };
  cache.set(layerId, entry);
  cacheBytes += entry.bytes;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
    const [oldest, evicted] = cache.entries().next().value!;
    cache.delete(oldest);
    cacheBytes -= evicted.bytes;
  }
  return value;
}
