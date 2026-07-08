import type { InstallResult, ItemCapabilities } from '@/lib/marketplace-client';

/** Everything the install success toast needs, decoupled from the mutation's
 *  raw response shape so it's independently testable. */
export interface InstallSuccessSummary {
  title: string;
  description: string;
}

/** Builds the "what landed" toast copy from the install response — the item
 *  title plus a plain-English file count, singular/plural handled inline. */
export function buildInstallSuccessSummary(
  itemTitle: string,
  result: Pick<InstallResult, 'file_count'>,
): InstallSuccessSummary {
  const { file_count } = result;
  return {
    title: `Added ${itemTitle}`,
    description: `Committed ${file_count} file${file_count === 1 ? '' : 's'} — live in the next session.`,
  };
}

/** Deep-link destination for "View in project" — the customize overlay's
 *  Marketplace section (installed tab lives there), scoped to the project the
 *  item just landed in. Kept as a plain path builder (no router dependency)
 *  so it's testable and reusable from both in-app navigation and a toast
 *  action that has to work from any page, including the public marketplace. */
export function projectMarketplaceHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/customize/marketplace`;
}

/** True when an item exposes any secrets/connectors/tools it needs — used to
 *  decide whether the modal renders the capabilities panel at all. */
export function hasCapabilities(caps: ItemCapabilities | null | undefined): boolean {
  return !!caps && caps.secrets.length + caps.connectors.length + caps.tools.length > 0;
}

/** Total capability count across all three kinds, for the section's count
 *  badge. */
export function capabilityCount(caps: ItemCapabilities | null | undefined): number {
  if (!caps) return 0;
  return caps.secrets.length + caps.connectors.length + caps.tools.length;
}

/** Whether the install control should be disabled: no item resolved yet, no
 *  destination project chosen (picker mode), or a request already in flight —
 *  the single source of truth so the button and the Enter-to-submit handler
 *  can't disagree about when a submit is valid. */
export function isInstallDisabled(params: {
  hasItem: boolean;
  targetProjectId: string;
  pending: boolean;
}): boolean {
  return !params.hasItem || !params.targetProjectId || params.pending;
}
