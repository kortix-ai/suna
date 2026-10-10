import type { ElementNode } from '@openuidev/lang-core';

import { GENUI_MAX_DEPTH, GENUI_MAX_NODES, GENUI_SPECS } from './catalog';
import type { GenuiIssue, GenuiNode } from './types';
import { safeUrl } from './urls';

const isElement = (value: unknown): value is ElementNode =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'element';

/** `node` when the slot accepts it or it is a block (it can rise to a Stack); otherwise its children, the same way. */
function fit(node: GenuiNode, accepts: readonly string[]): GenuiNode[] {
  const spec = GENUI_SPECS[node.type];
  if (accepts.includes(node.type) || spec?.block) return [node];
  const children = Object.keys(spec?.slots ?? {}).flatMap((key) => (node.props[key] ?? []) as GenuiNode[]);
  return children.flatMap((child) => fit(child, accepts));
}

/**
 * Turn lang-core's element tree into render-ready `GenuiNode`s.
 *
 * lang-core checks types, enums, and required props only. This pass adds what it skips:
 * zod limits (lengths, counts, ranges), slot membership, nesting depth, URL safety, and
 * unique React keys, and a total node budget (`GENUI_MAX_NODES`: one reference used many times
 * re-materializes its subtree each time). A node that fails is dropped and recorded in `issues`; its siblings render.
 * A node that fails its schema gives up its valid subtrees, in source order, to its parent's slot. A subtree that
 * slot does not accept rises to the nearest ancestor that does when it is a block; otherwise it gives up its own
 * children the same way. A root that fails becomes a Stack of its valid subtrees.
 */
export function sanitizeTree(
  root: ElementNode | null,
  options: {
    streaming: boolean;
    /**
     * Name of the statement the model is still writing, or null. lang-core marks EVERY node partial
     * while the input ends mid-statement, so "partial" is decided here instead (see parse.ts).
     */
    unfinished: string | null;
  },
): { root: GenuiNode | null; issues: GenuiIssue[] } {
  const issues: GenuiIssue[] = [];
  const usedIds = new Map<string, number>();
  let nodeCount = 0;
  const uniqueId = (base: string): string => {
    const seen = usedIds.get(base) ?? 0;
    usedIds.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${seen}`;
  };

  /** The node, or its valid subtrees when it fails its schema, then the blocks its slots did not accept. */
  function visit(
    value: unknown,
    path: string,
    depth: number,
    accepts: readonly string[],
    parentPartial: boolean,
  ): GenuiNode[] {
    if (!isElement(value)) return [];
    const { typeName, statementId } = value;
    // A named statement is partial only if it is the one being written; an inline node inherits.
    const partial = statementId !== undefined ? statementId === options.unfinished : parentPartial;
    const spec = GENUI_SPECS[typeName];
    if (!spec) {
      issues.push({ code: 'unknown-component', component: typeName, statementId, message: `Unknown component ${typeName}` });
      return [];
    }
    if (!accepts.includes(typeName)) {
      issues.push({ code: 'wrong-child', component: typeName, statementId, message: `${typeName} is not allowed here` });
      return [];
    }
    const nextDepth = spec.container ? depth + 1 : depth;
    if (nextDepth > GENUI_MAX_DEPTH) {
      issues.push({ code: 'depth', component: typeName, statementId, message: `Nesting deeper than ${GENUI_MAX_DEPTH}` });
      return [];
    }

    // Reserve a slot before visiting children. This bounds the output only: lang-core has already
    // expanded the tree, and `expansionIssue` (expansion.ts) bounds that expansion before lang-core runs.
    if (nodeCount >= GENUI_MAX_NODES) {
      if (!issues.some((issue) => issue.code === 'too-many-nodes')) {
        issues.push({ code: 'too-many-nodes', message: `Block expands to more than ${GENUI_MAX_NODES} nodes; the rest is dropped` });
      }
      return [];
    }
    nodeCount++;

    // The stream is over and this statement never finished: drop it instead of waiting forever.
    if (partial && !options.streaming) {
      issues.push({ code: 'cut-off', component: typeName, statementId, message: `${typeName} was cut off` });
      return [];
    }

    const id = uniqueId(statementId ?? path);
    const props: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(value.props)) {
      if (prop !== null && prop !== undefined) props[key] = prop;
    }

    // Every valid subtree in source order (what a schema failure gives up), and the blocks no slot here accepts.
    const subtrees: GenuiNode[] = [];
    const rising: GenuiNode[] = [];
    for (const [key, slot] of Object.entries(spec.slots)) {
      const raw = props[key];
      if (raw === undefined) continue;
      const children = Array.isArray(raw) ? raw : [raw];
      const kept: GenuiNode[] = [];
      children.forEach((child, index) => {
        const nodes = visit(child, `${id}.${key}.${index}`, nextDepth, slot.accepts, partial);
        for (const node of nodes.flatMap((n) => fit(n, slot.accepts))) {
          subtrees.push(node);
          (slot.accepts.includes(node.type) ? kept : rising).push(node);
        }
      });
      props[key] = kept;
    }

    for (const [key, need] of Object.entries(spec.urls)) {
      if (props[key] === undefined) continue;
      const safe = safeUrl(props[key]);
      if (safe) {
        props[key] = safe;
        continue;
      }
      issues.push({ code: 'url', component: typeName, statementId, message: `Unsafe URL in ${typeName}.${key}` });
      if (need === 'required') return [];
      delete props[key];
    }

    if (!partial) {
      const result = (options.streaming ? spec.streaming : spec.strict).safeParse(props);
      if (!result.success) {
        const first = result.error.issues[0];
        issues.push({
          code: 'schema',
          component: typeName,
          statementId,
          message: `${typeName}.${first?.path.join('.') ?? ''}: ${first?.message ?? 'invalid'}`,
        });
        return subtrees;
      }
    }

    return [{ id, type: typeName, props, partial }, ...rising];
  }

  const top = visit(root, 'root', 0, ['Stack'], false);
  if (top.length === 0) return { root: null, issues };
  if (top.length === 1 && top[0]!.type === 'Stack') return { root: top[0]!, issues };
  return { root: { id: uniqueId('root'), type: 'Stack', props: { children: top }, partial: false }, issues };
}
