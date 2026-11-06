/**
 * The IAM answers the palette reads, settled into plain values: the account
 * hub sections the caller may open (`useAccountHubAccess().sectionVisible`)
 * and, by row id, the verdict of the sidebar row a palette row mirrors.
 */
export interface PaletteGates {
  accountSections: Readonly<Record<string, boolean>>;
  rows: Readonly<Record<string, boolean>>;
}

/**
 * A row the caller cannot act on is not offered. An account row follows its
 * hub section, the same rule as the hub's own nav; a project row follows the
 * sidebar row it mirrors. A row with no entry has no permission gate.
 */
export function paletteRowPermitted(
  item: { id: string; kind?: string; accountTab?: string },
  gates: PaletteGates,
): boolean {
  if (item.kind === 'account' && item.accountTab) {
    return gates.accountSections[item.accountTab] === true;
  }
  return gates.rows[item.id] ?? true;
}
