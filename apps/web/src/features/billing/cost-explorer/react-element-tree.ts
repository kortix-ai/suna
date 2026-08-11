/**
 * Test-only tree walker over a React element returned by calling a hook-free
 * function component DIRECTLY — not through ReactDOM or SSR.
 *
 * Why it exists: `apps/web` renders its tests with `renderToStaticMarkup`,
 * which strips event-handler props from the HTML it emits, so "does clicking
 * this call that with those arguments" is not assertable from markup. Calling
 * the component function returns the real element tree instead, which `onClick`
 * / `onSort` survive on.
 *
 * It never invokes a nested component function, so it sees the elements the
 * component itself created — which is exactly the boundary the tests care
 * about (what this component wired up), not what its children later render.
 *
 * It descends through EVERY prop value, not just `children`. These components
 * pass elements through named render props as well — `CostLevelShell` takes
 * the export button and the filters as `controls`, and the level's table as
 * `children` — so a children-only walk cannot see half of what a level
 * assembles.
 *
 * Shared by `workspaces-level.test.tsx` and `sessions-level.test.tsx`. Not
 * imported by any application module — deliberately named without `.test.` so
 * the runner does not treat it as a suite of its own.
 */
export interface WalkedElement {
  type: unknown;
  props: Record<string, unknown>;
}

export function collectElementsByType(
  node: unknown,
  type: unknown,
  acc: WalkedElement[] = [],
): WalkedElement[] {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectElementsByType(item, type, acc);
    return acc;
  }

  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (!element.props) return acc;

  if (element.type === type) acc.push({ type: element.type, props: element.props });
  for (const value of Object.values(element.props)) collectElementsByType(value, type, acc);
  return acc;
}
