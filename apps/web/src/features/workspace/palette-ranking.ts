/**
 * ============================================================================
 * WHAT ORDER THE COMMAND PALETTE'S RESULTS COME BACK IN.
 * ============================================================================
 *
 * `command-palette-search.test.ts` pins what a row is searchable BY.
 * `menu-registry-destinations.test.ts` pins that a row EXISTS per destination.
 * This module is the third leg: given the rows a query matched, which one is
 * FIRST.
 *
 * **Why the palette has to rank at all — cmdk 0.2.1 cannot.** The reported
 * symptom was typing "secret" and getting the user-scoped "API keys" settings
 * row above the workspace's Secrets page. Two separate defects in the
 * installed cmdk (checked against
 * `node_modules/.pnpm/cmdk@0.2.1/.../dist/index.mjs`, function `N`, the sort
 * pass) mean it never produced a usable order here:
 *
 *   1. **Items are never sorted.** `N()` sorts the item nodes with
 *      `scores.get(node.getAttribute('data-value'))`, but `filtered.items` is
 *      keyed by each item's React `useId()` — `store.value(id, valueString)`
 *      writes `filtered.items.set(id, score)`. Every lookup therefore misses,
 *      every comparison is `0 - 0`, and the sort is a stable no-op. Row order
 *      inside a group has always been React render order, which is why
 *      `command-palette.tsx` documents that `filteredNavItems` "preserves
 *      registry declaration order rather than ranking by relevance".
 *   2. **Group order goes to NaN.** Group scores DO use ids
 *      (`groups.get(groupId).forEach(id => max = Math.max(scores.get(id), max))`),
 *      so they start out correct — but an item's unmount cleanup deletes it
 *      from `allItems`, `allIds` and `filtered.items` and NOT from the group's
 *      own id Set. This palette re-renders its row list on every keystroke
 *      (our filter decides what is mounted), so those Sets fill with stale
 *      ids, `scores.get(staleId)` is `undefined`, and `Math.max(undefined, n)`
 *      is `NaN`. One stale id poisons a whole group's score, and a comparator
 *      returning NaN leaves `Array.prototype.sort` free to do anything.
 *
 * So the palette passes `shouldFilter={false}` and owns both decisions: which
 * rows exist (it already did — every group is `forceMount`, and
 * `filteredNavItems` / `filterSettingsPaletteGroups` are the real filter) and
 * now what order they come in. cmdk's `N()` returns early on that flag, so
 * nothing re-appends nodes behind our back and DOM order — which is also
 * arrow-key order — is exactly what this module computes.
 *
 * **Why a purpose-built scorer rather than `command-score`.** cmdk's scorer is
 * a fuzzy subsequence matcher, and its judgements are not the ones this
 * surface wants: it scores "Preferences" at 0.80 for the query "model" (via
 * the letters of "mode") and "API keys" at 0.89 for "secret". The rule people
 * actually expect from a palette is blunt and statable in one line — **the row
 * whose LABEL is what you typed wins, and a keyword match never beats a label
 * match** — so it is written out below as a ladder of named weights instead of
 * emerging from a similarity metric.
 */

/** One rankable row: what the user reads, and what it is also searchable by. */
export interface PaletteRankable {
  label: string;
  keywords?: string;
}

/**
 * The ladder, strongest first. The gaps are deliberate and the ORDER is the
 * contract — a keyword match must never outrank a label match, however good.
 *
 * `LABEL_PREFIX` above `LABEL_WORD_EXACT` is what makes "secret" answer
 * `Secrets` (whole label, one word, prefix) ahead of `Settings · General`
 * (a label WORD, exact) for queries where both apply.
 */
const WEIGHT = {
  /** The whole label is the word: "Secrets" for "secrets". */
  LABEL_EXACT: 1000,
  /** The whole label starts with it: "Secrets" for "secret", "Models" for "model". */
  LABEL_PREFIX: 900,
  /** A word of the label is it: "Settings · General" for "settings". */
  LABEL_WORD_EXACT: 850,
  /** A word of the label starts with it: "Connectors · Policies" for "polic". */
  LABEL_WORD_PREFIX: 800,
  /** The label contains it mid-word: "Sub-agents" for "agent". */
  LABEL_SUBSTRING: 700,
  /** A keyword is it: "API keys" for "pat". */
  KEYWORD_EXACT: 600,
  /** A keyword starts with it: "Triggers" for "webhook". */
  KEYWORD_PREFIX: 500,
  /** A keyword contains it mid-word: "Channels" for "agent" (via "agentmail"). */
  KEYWORD_SUBSTRING: 400,
} as const;

/**
 * Split into comparable words. Punctuation becomes a gap, so the `·` in
 * "Account · Members" and the `_` in `llm_gateway` both stop being part of a
 * word — a person typing "members" or "gateway" means the word, not the
 * separator that happens to sit beside it.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** The strongest rung one query word reaches on one row. 0 = no match at all. */
function scoreWord(row: PaletteRankable, word: string): number {
  const label = row.label.toLowerCase();
  const labelWords = words(row.label);
  if (label === word) return WEIGHT.LABEL_EXACT;
  if (label.startsWith(word)) return WEIGHT.LABEL_PREFIX;
  if (labelWords.includes(word)) return WEIGHT.LABEL_WORD_EXACT;
  if (labelWords.some((w) => w.startsWith(word))) return WEIGHT.LABEL_WORD_PREFIX;
  if (label.includes(word)) return WEIGHT.LABEL_SUBSTRING;

  const keywords = (row.keywords ?? '').toLowerCase();
  if (!keywords) return 0;
  const keywordWords = words(keywords);
  if (keywordWords.includes(word)) return WEIGHT.KEYWORD_EXACT;
  if (keywordWords.some((w) => w.startsWith(word))) return WEIGHT.KEYWORD_PREFIX;
  if (keywords.includes(word)) return WEIGHT.KEYWORD_SUBSTRING;
  return 0;
}

/**
 * A row's relevance to a whole query: the MEAN of its per-word rungs, so a
 * two-word query and a one-word query produce comparable numbers and a row is
 * not rewarded for the query being long.
 *
 * A word that matches nothing zeroes the row. That can only happen for a row
 * the palette's own visibility filter (every word must be a substring
 * somewhere) would already have dropped — the two agree by construction, and
 * the zero is the safety net if they ever stop agreeing.
 *
 * An empty query scores every row 0, which leaves `rankRows` a stable no-op —
 * exactly right, because with no query the palette is showing a curated list
 * (Suggestions, Recent sessions) whose order is editorial, not computed.
 */
export function rankScore(row: PaletteRankable, query: string): number {
  const queryWords = words(query);
  if (queryWords.length === 0) return 0;
  let total = 0;
  for (const word of queryWords) {
    const score = scoreWord(row, word);
    if (score === 0) return 0;
    total += score;
  }
  return total / queryWords.length;
}

/**
 * The rows, best first. STABLE: rows that score the same keep the order they
 * came in, which for registry rows is declaration order — so curation in
 * `menu-registry.ts` stays the tie-break and nothing reshuffles between
 * keystrokes for no reason.
 */
export function rankRows<T extends PaletteRankable>(rows: readonly T[], query: string): T[] {
  const scored = rows.map((row, index) => ({ row, index, score: rankScore(row, query) }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.row);
}

/**
 * A group's relevance: its best row's. Used to order the RESULT GROUPS against
 * each other, so a query whose best answer lives under "Settings" puts that
 * heading first — the thing cmdk's NaN-poisoned group sort was supposed to do.
 *
 * An empty group scores 0 rather than -Infinity so that a group with no rows
 * sorts alongside the no-query case instead of being pushed behind rows that
 * did not match either.
 */
export function bestRankScore(rows: readonly PaletteRankable[], query: string): number {
  let best = 0;
  for (const row of rows) {
    const score = rankScore(row, query);
    if (score > best) best = score;
  }
  return best;
}

/** One result group, with the rows that decide where the whole group sits. */
export interface RankableGroup<T> {
  /** Stable React key, and the readable name in test failures. */
  key: string;
  /** Every row under this heading, already filtered and already row-ranked. */
  rows: readonly PaletteRankable[];
  /** Whatever the caller wants back — a React node, in the palette's case. */
  node: T;
}

/**
 * The groups, best first, stable within a tie. The caller passes them in its
 * own editorial order (Session actions, Navigation, Settings, Sessions,
 * Projects); that order survives wherever the query does not distinguish them.
 */
export function rankGroups<T>(
  groups: readonly RankableGroup<T>[],
  query: string,
): RankableGroup<T>[] {
  const scored = groups.map((group, index) => ({
    group,
    index,
    score: bestRankScore(group.rows, query),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.group);
}
