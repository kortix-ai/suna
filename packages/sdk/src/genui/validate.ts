import type { ElementNode } from '@openuidev/lang-core';

import { GENUI_MAX_DEPTH, GENUI_MAX_NODES, GENUI_SPECS } from './catalog';
import type { GenuiIssue, GenuiNode } from './types';
import { safeUrl } from './urls';

const isElement = (value: unknown): value is ElementNode =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'element';

/**
 * Turn lang-core's element tree into render-ready `GenuiNode`s.
 *
 * lang-core checks types, enums, and required props only. This pass adds what it skips:
 * zod limits (lengths, counts, ranges), slot membership, nesting depth, URL safety, and
 * unique React keys, and a total node budget (`GENUI_MAX_NODES`: one reference used many times
 * re-materializes its subtree each time). A node that fails is dropped and recorded in `issues`; its siblings render.
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

  function visit(
    value: unknown,
    path: string,
    depth: number,
    accepts: readonly string[],
    parentPartial: boolean,
  ): GenuiNode | null {
    if (!isElement(value)) return null;
    const { typeName, statementId } = value;
    // A named statement is partial only if it is the one being written; an inline node inherits.
    const partial = statementId !== undefined ? statementId === options.unfinished : parentPartial;
    const spec = GENUI_SPECS[typeName];
    if (!spec) {
      issues.push({ code: 'unknown-component', component: typeName, statementId, message: `Unknown component ${typeName}` });
      return null;
    }
    if (!accepts.includes(typeName)) {
      issues.push({ code: 'wrong-child', component: typeName, statementId, message: `${typeName} is not allowed here` });
      return null;
    }
    const nextDepth = spec.container ? depth + 1 : depth;
    if (nextDepth > GENUI_MAX_DEPTH) {
      issues.push({ code: 'depth', component: typeName, statementId, message: `Nesting deeper than ${GENUI_MAX_DEPTH}` });
      return null;
    }

    // Reserve a slot before visiting children. This bounds the output only: lang-core has already
    // expanded the tree, and `expansionIssue` (expansion.ts) bounds that expansion before lang-core runs.
    if (nodeCount >= GENUI_MAX_NODES) {
      if (!issues.some((issue) => issue.code === 'too-many-nodes')) {
        issues.push({ code: 'too-many-nodes', message: `Block expands to more than ${GENUI_MAX_NODES} nodes; the rest is dropped` });
      }
      return null;
    }
    nodeCount++;

    // The stream is over and this statement never finished: drop it instead of waiting forever.
    if (partial && !options.streaming) {
      issues.push({ code: 'cut-off', component: typeName, statementId, message: `${typeName} was cut off` });
      return null;
    }

    const id = uniqueId(statementId ?? path);
    const props: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(value.props)) {
      if (prop !== null && prop !== undefined) props[key] = prop;
    }

    for (const [key, slot] of Object.entries(spec.slots)) {
      const raw = props[key];
      if (raw === undefined) continue;
      const children = Array.isArray(raw) ? raw : [raw];
      props[key] = children
        .map((child, index) => visit(child, `${id}.${key}.${index}`, nextDepth, slot.accepts, partial))
        .filter((node): node is GenuiNode => node !== null);
    }

    for (const [key, need] of Object.entries(spec.urls)) {
      if (props[key] === undefined) continue;
      const safe = safeUrl(props[key]);
      if (safe) {
        props[key] = safe;
        continue;
      }
      issues.push({ code: 'url', component: typeName, statementId, message: `Unsafe URL in ${typeName}.${key}` });
      if (need === 'required') return null;
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
        return null;
      }
    }

    return { id, type: typeName, props, partial };
  }

  return { root: visit(root, 'root', 0, ['Stack'], false), issues };
}
