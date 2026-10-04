/**
 * Namespaces the template-row predecessor reaper can delete without a
 * data-plane ownership check. `kpp2-` is intentionally absent. Its first key
 * identifies the owning data plane, but this reaper does not receive or prove
 * that identity. The ownership-aware per-project reaper handles scoped images;
 * Daytona quota GC provides the pressure backstop on that provider.
 */
const REAPABLE_TEMPLATE_PREDECESSOR_PREFIXES = [
  'kortix-default-',
  'kortix-tpl-',
  'kortix-wproj-',
  'kortix-ppwarm-',
] as const;

export function isReapableTemplatePredecessor(snapshotName: string): boolean {
  return REAPABLE_TEMPLATE_PREDECESSOR_PREFIXES.some((prefix) =>
    snapshotName.startsWith(prefix),
  );
}
