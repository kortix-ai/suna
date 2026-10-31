/**
 * Deprecations: how kortix.yaml stays backward compatible without a version.
 *
 * A key is never removed or repurposed in place. When a shape is replaced, it
 * gets an entry here: an id, the date it was deprecated, one sentence that
 * names the replacement, and `apply`, a rewrite to the latest shape that keeps
 * what the file means. Then:
 *
 *   - Readers apply every rewrite in memory (`validateManifest` returns the
 *     rewritten document as `parsed`), so a running project always reads the
 *     latest shape and the old one keeps working.
 *   - Each rewritten occurrence is a `warning` with `fix: <id>` and the line of
 *     the old key, shown by `kortix validate`, the project banner and the API.
 *   - Writers save the latest shape: `fixManifestText` rewrites the text and
 *     keeps comments (`kortix validate --fix`, every Kortix write).
 *
 * Entries stay: a rewrite is a few lines, and an old file may arrive at any
 * time (a repository import, an old branch). A shape with no rewrite that keeps
 * its meaning is not a deprecation: it stays an error with its replacement
 * named (`RETIRED_*_KEYS` in `./index.v3.ts`).
 */

import { isDeepStrictEqual } from 'node:util';
import { type Document, isMap, isScalar, isSeq, type Node, type Pair, parseDocument, Scalar, type YAMLMap } from 'yaml';
import { DEPRECATED_KORTIX_PERMISSION_ALIASES, LEGACY_SANDBOX_KEYS, RETIRED_KORTIX_TOOLS } from './constants';

export interface Deprecation {
  /** Stable id, shown as `fix: <id>`. Never reused. */
  id: string;
  /** The date the old shape was deprecated (YYYY-MM-DD). */
  since: string;
  /** The old shape and what replaces it. */
  summary: string;
  /** Rewrite every occurrence to the latest shape, in place. Returns the path of each occurrence. */
  apply(doc: Document): string[];
}

/** One applied rewrite: where the old shape was. */
export interface AppliedFix {
  id: string;
  path: string;
}

/** `agents.<name>` blocks as [name, map] pairs. */
function agentBlocks(doc: Document): Array<[string, YAMLMap]> {
  const agents = doc.get('agents', true);
  if (!isMap(agents)) return [];
  return agents.items.flatMap((pair) => {
    const name = isScalar(pair.key) ? String(pair.key.value) : null;
    return name !== null && isMap(pair.value) ? [[name, pair.value as YAMLMap] as [string, YAMLMap]] : [];
  });
}

type Commented = { commentBefore?: string | null; comment?: string | null; spaceBefore?: boolean };

/** The pair of `map` whose key is `key`; a plain-string key becomes a scalar node so it can hold a comment. */
function pairOf(map: YAMLMap, key: string): Pair<Node, unknown> | undefined {
  const pair = map.items.find((item) => item.key === key || (isScalar(item.key) && item.key.value === key)) as Pair<unknown, unknown> | undefined;
  if (pair && typeof pair.key === 'string') pair.key = new Scalar(pair.key);
  return pair as Pair<Node, unknown> | undefined;
}

/**
 * Delete `key` from `map` and keep the comments written above and beside it:
 * they move to the key `to` when given, else to the next key, else after the map.
 */
function deleteKeepingComments(map: YAMLMap, key: string, to?: string): void {
  const pair = pairOf(map, key);
  if (!pair) return;
  const keyNode = pair.key as Commented;
  const value = pair.value as Commented | null;
  const before = [keyNode.commentBefore, value && typeof value === 'object' ? value.comment : null].filter(Boolean).join('\n');
  const index = map.items.indexOf(pair as never);
  map.delete(key);
  const next = map.items[index] as Pair<unknown, unknown> | undefined;
  const nextKey = next ? (next.key && typeof next.key === 'object' ? next.key : ((next.key = new Scalar(next.key)) as Scalar)) : undefined;
  // The next key takes the deleted key's place, blank line included.
  if (to === undefined && nextKey) (nextKey as Commented).spaceBefore = keyNode.spaceBefore;
  if (!before) return;
  const target = (to !== undefined ? pairOf(map, to)?.key : nextKey) as Commented | undefined;
  if (target) target.commentBefore = [before, target.commentBefore].filter(Boolean).join('\n');
  else (map as Commented).comment = [(map as Commented).comment, before].filter(Boolean).join('\n');
}

/** Move `block.<from>` to `block.<to>` when `<to>` is absent (or holds the same value). */
function renameAgentKey(doc: Document, from: string, to: string, map: (value: unknown) => unknown = (v) => v): string[] {
  const paths: string[] = [];
  for (const [name, block] of agentBlocks(doc)) {
    if (!block.has(from)) continue;
    const value = map(block.toJSON()[from]);
    const existing = block.toJSON()[to];
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) continue; // a conflict stays an error
    if (existing === undefined) block.set(to, doc.createNode(value));
    deleteKeepingComments(block, from, to);
    paths.push(`agents.${name}.${from}`);
  }
  return paths;
}

export const DEPRECATIONS: readonly Deprecation[] = [
  {
    id: 'drop-kortix-version',
    since: '2026-10-30',
    summary: '`kortix_version` is obsolete: the format has no version. Delete the line.',
    apply: (doc) => {
      if (doc.get('kortix_version') !== 3 || !isMap(doc.contents)) return [];
      deleteKeepingComments(doc.contents as YAMLMap, 'kortix_version');
      return ['kortix_version'];
    },
  },
  {
    id: 'tools-explicit',
    since: '2026-10-27',
    summary: 'an agent without `tools` gets every tool. Write `tools: all` (same meaning), or list the tools it needs.',
    apply: (doc) =>
      agentBlocks(doc).flatMap(([name, block]) => {
        if (block.has('tools')) return [];
        block.set('tools', 'all');
        return [`agents.${name}.tools`];
      }),
  },
  {
    id: 'agent-disable',
    since: '2026-10-21',
    summary: '`disable` is now `enabled` (the opposite value).',
    apply: (doc) => renameAgentKey(doc, 'disable', 'enabled', (value) => value !== true),
  },
  {
    id: 'agent-env',
    since: '2026-10-21',
    summary: "an agent's `env` grant is now `secrets`.",
    apply: (doc) => renameAgentKey(doc, 'env', 'secrets'),
  },
  {
    id: 'agent-kortix-cli',
    since: '2026-10-21',
    summary: '`kortix_cli` is now `kortix_permissions` (same value).',
    apply: (doc) => renameAgentKey(doc, 'kortix_cli', 'kortix_permissions'),
  },
  {
    id: 'agent-connectors-personal',
    since: '2026-10-21',
    summary: '`connectors_personal` is now `connectors_required` (same value).',
    apply: (doc) => renameAgentKey(doc, 'connectors_personal', 'connectors_required'),
  },
  {
    id: 'agent-repository-access',
    since: '2026-10-21',
    summary: '`repository_access: <bool>` is now `workspace: { project_repository: <bool> }`.',
    apply: (doc) =>
      agentBlocks(doc).flatMap(([name, block]) => {
        const access = block.toJSON().repository_access;
        if (typeof access !== 'boolean' || block.has('workspace')) return [];
        block.set('workspace', doc.createNode({ project_repository: access }));
        deleteKeepingComments(block, 'repository_access', 'workspace');
        return [`agents.${name}.repository_access`];
      }),
  },
  {
    id: 'agent-workspace-mode',
    since: '2026-10-21',
    summary: '`workspace: branch` and `workspace: runtime` are now `workspace: { project_repository: true | false }`.',
    apply: (doc) =>
      agentBlocks(doc).flatMap(([name, block]) => {
        const mode = block.toJSON().workspace;
        if (mode !== 'branch' && mode !== 'runtime') return [];
        block.set('workspace', doc.createNode({ project_repository: mode === 'branch' }));
        return [`agents.${name}.workspace`];
      }),
  },
  {
    id: 'sandbox-templates',
    since: '2026-09-15',
    summary: 'the top-level `sandboxes` list is now `sandbox.templates`.',
    apply: (doc) => {
      const list = doc.get('sandboxes', true);
      if (!isSeq(list) || doc.hasIn(['sandbox', 'templates'])) return [];
      if (!doc.has('sandbox')) doc.set('sandbox', doc.createNode({}));
      if (!isMap(doc.get('sandbox', true))) return [];
      doc.setIn(['sandbox', 'templates'], list);
      deleteKeepingComments(doc.contents as YAMLMap, 'sandboxes');
      return ['sandboxes'];
    },
  },
  {
    id: 'sandbox-singular',
    since: '2026-05-26',
    summary: 'image keys set on `sandbox` itself (the singular `[sandbox]` table) are now one `sandbox.templates` entry, named as `sandbox.default`.',
    apply: (doc) => {
      const sandbox = doc.get('sandbox', true);
      if (!isMap(sandbox)) return [];
      const keys = LEGACY_SANDBOX_KEYS.filter((key) => sandbox.has(key));
      if (keys.length === 0) return [];
      const values = sandbox.toJSON() as Record<string, unknown>;
      const slug = typeof values.slug === 'string' && values.slug.trim() ? values.slug.trim() : 'project';
      const template = Object.fromEntries([['slug', slug], ...keys.filter((key) => key !== 'slug').map((key) => [key, values[key]])]);
      const templates = sandbox.get('templates', true);
      if (isSeq(templates)) {
        if ((templates.toJSON() as Array<{ slug?: unknown }>).some((t) => t?.slug === slug)) return [];
        templates.add(doc.createNode(template));
      } else if (!sandbox.has('templates')) {
        sandbox.set('templates', doc.createNode([template]));
      } else return [];
      for (const key of keys) sandbox.delete(key);
      if (!sandbox.has('default')) sandbox.set('default', slug);
      return ['sandbox'];
    },
  },
  {
    id: 'acp-runtimes',
    since: '2026-07-30',
    summary: '`runtimes` and an agent\'s `runtime` and `agent` keys selected a harness that was removed: every session runs pi. Delete them.',
    apply: (doc) => {
      const paths: string[] = [];
      if (doc.has('runtimes') && isMap(doc.contents)) {
        deleteKeepingComments(doc.contents as YAMLMap, 'runtimes');
        paths.push('runtimes');
      }
      for (const [name, block] of agentBlocks(doc)) {
        for (const key of ['runtime', 'agent']) {
          if (!block.has(key)) continue;
          deleteKeepingComments(block, key);
          paths.push(`agents.${name}.${key}`);
        }
      }
      return paths;
    },
  },
  {
    id: 'permission-renamed',
    since: '2026-10-08',
    summary: 'a renamed Kortix permission in `kortix_permissions` is written with its new name.',
    apply: (doc) =>
      agentBlocks(doc).flatMap(([name, block]) => {
        const list = block.get('kortix_permissions', true);
        if (!isSeq(list)) return [];
        const values = list.toJSON() as unknown[];
        if (!values.some((v) => typeof v === 'string' && v.trim() in DEPRECATED_KORTIX_PERMISSION_ALIASES)) return [];
        const next = [...new Set(values.flatMap((v): unknown[] => (typeof v === 'string' && DEPRECATED_KORTIX_PERMISSION_ALIASES[v.trim()]) ? [...DEPRECATED_KORTIX_PERMISSION_ALIASES[v.trim()]!] : [v]))];
        block.set('kortix_permissions', doc.createNode(next));
        return [`agents.${name}.kortix_permissions`];
      }),
  },
  {
    id: 'tool-retired',
    since: '2026-10-19',
    summary:
      'a retired Kortix tool name does nothing: it is removed from the list, unless the project registers its own tool under that name. ' +
      'For `memory`: agents edit `memory/` with the file tools, and My Kortix remembers each person with `kortix_memory`.',
    apply: (doc) => {
      // `tools.memory: tools/memory.ts` (an ejected copy) keeps `memory` a live project tool.
      const registry = doc.get('tools', true);
      const owned = (name: string) => isMap(registry) && registry.has(name);
      return agentBlocks(doc).flatMap(([name, block]) => {
        const tools = block.get('tools', true);
        const list = isSeq(tools) ? tools : isMap(tools) && isSeq(tools.get('exclude', true)) ? (tools.get('exclude', true) as typeof tools) : null;
        if (!list || !isSeq(list)) return [];
        const before = list.items.length;
        list.items = list.items.filter((item) => !(isScalar(item) && RETIRED_KORTIX_TOOLS.includes(String(item.value)) && !owned(String(item.value))));
        return list.items.length < before ? [`agents.${name}.tools`] : [];
      });
    },
  },
];

/** Apply every deprecation to `doc`, in place. */
export function applyDeprecations(doc: Document): AppliedFix[] {
  return DEPRECATIONS.flatMap((deprecation) => deprecation.apply(doc).map((path) => ({ id: deprecation.id, path })));
}

/**
 * `text` rewritten to the latest shape, comments kept. Unchanged (the same
 * bytes) when nothing is deprecated or the YAML does not parse. Every line a
 * deprecation does not change keeps its bytes (`keepUnchangedLines`).
 */
export function fixManifestText(text: string): { text: string; fixed: AppliedFix[] } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { text, fixed: [] };
  const fixed = applyDeprecations(doc);
  if (fixed.length === 0) return { text, fixed };
  // No folding of long lines, no padding inside `[a, b]`.
  const rendered = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return { text: keepUnchangedLines(text, rendered), fixed };
}

/**
 * `source` with its content replaced by `desired`, written into the file's own
 * YAML document: every comment and every line the edit does not touch keep
 * their bytes. Deprecated shapes are rewritten first (`fixManifestText`). Null
 * when `source` does not parse or the result would not read as `desired`: the
 * caller then renders `desired` from scratch.
 */
export function rewriteManifestText(source: string, desired: Record<string, unknown>): string | null {
  const healed = fixManifestText(source).text;
  const doc = parseDocument(healed);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  syncNode(doc, doc.contents, desired);
  const text = keepUnchangedLines(healed, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  const read = parseDocument(text);
  if (read.errors.length > 0 || !isDeepStrictEqual(read.toJS(), desired)) return null;
  return text;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Make `node` hold `value`: a map or a list of the same length is synced entry by entry, anything else replaced. */
function syncNode(doc: Document, node: unknown, value: unknown): unknown {
  if (isMap(node) && isPlainObject(value)) {
    // An empty `{}` that gains entries is written as a block; a filled flow map keeps its style.
    if (node.flow && node.items.length === 0 && Object.keys(value).length > 0) node.flow = false;
    for (const pair of [...node.items]) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (!Object.hasOwn(value, key)) node.delete(pair.key);
    }
    for (const [key, next] of Object.entries(value)) {
      if (next === undefined) continue;
      const pair = node.items.find((item) => (isScalar(item.key) ? String(item.key.value) : String(item.key)) === key);
      if (!pair) node.set(doc.createNode(key), doc.createNode(next));
      else pair.value = syncNode(doc, pair.value, next) as Node;
    }
    return node;
  }
  // An empty `[]` that gains items is written as a block list.
  if (isSeq(node) && Array.isArray(value) && node.items.length === 0 && value.length > 0) return doc.createNode(value);
  if (isSeq(node) && Array.isArray(value) && node.items.length === value.length) {
    node.items = node.items.map((item, index) => syncNode(doc, item, value[index]) as Node);
    return node;
  }
  const current = node && typeof node === 'object' && 'toJSON' in node ? (node as { toJSON: () => unknown }).toJSON() : node;
  if (isDeepStrictEqual(current, value)) return node;
  return doc.createNode(value);
}

/** A line without the whitespace the YAML renderer may change in a line it did not edit: runs, and space beside `[]{},:`. */
const lineShape = (line: string) => line.replace(/\s+/g, ' ').replace(/ ?([[\]{},:]) ?/g, '$1').trim();

/**
 * `rendered` with each line that matches an original line, apart from
 * whitespace, put back as the original wrote it: a heal changes only the lines
 * it rewrites, not comment spacing or list indentation. The lines are paired
 * in order (longest common subsequence). When the result does not read as
 * `rendered` does, `rendered` is returned.
 */
function keepUnchangedLines(original: string, rendered: string): string {
  const a = original.split('\n');
  const b = rendered.split('\n');
  const as = a.map(lineShape);
  const bs = b.map(lineShape);
  // ponytail: O(n·m) table; a manifest is at most a few thousand lines.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = as[i] === bs[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && as[i] === bs[j]) {
      out.push(a[i]!);
      i++;
      j++;
    } else if (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else out.push(b[j++]!);
  }
  const merged = out.join('\n');
  const read = (yaml: string) => {
    const parsed = parseDocument(yaml);
    return parsed.errors.length > 0 ? null : JSON.stringify(parsed.toJS());
  };
  return read(merged) !== null && read(merged) === read(rendered) ? merged : rendered;
}
