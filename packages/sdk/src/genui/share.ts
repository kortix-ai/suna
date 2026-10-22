import type { GenuiNode } from './types';

const isNode = (value: unknown): value is GenuiNode =>
  typeof value === 'object' && value !== null && 'id' in value && 'type' in value && 'props' in value;

function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, index) => valueEqual(item, b[index]));
}

function propsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => valueEqual(a[key], b[key]));
}

/**
 * Structural sharing across parses: a node whose type, `partial` flag, props, and children did not
 * change keeps the object from the previous parse. Renderers memoize on node identity, so a statement
 * that finished streaming renders once and never again while later statements stream in.
 */
export function shareNodes(
  root: GenuiNode | null,
  previous: ReadonlyMap<string, GenuiNode>,
): { root: GenuiNode | null; byId: Map<string, GenuiNode> } {
  const byId = new Map<string, GenuiNode>();

  function share(node: GenuiNode): GenuiNode {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.props)) {
      props[key] = Array.isArray(value) && value.length > 0 && value.every(isNode) ? value.map(share) : value;
    }
    const before = previous.get(node.id);
    const kept =
      before && before.type === node.type && before.partial === node.partial && propsEqual(before.props, props)
        ? before
        : { ...node, props };
    byId.set(node.id, kept);
    return kept;
  }

  return { root: root ? share(root) : null, byId };
}
