export function shouldListLegacyMigrationItem(input: { status: string }) {
  // Archived legacy machines are old migration artifacts. The target project,
  // if still accessible, is already listed through the normal projects route.
  return input.status !== 'archived';
}
