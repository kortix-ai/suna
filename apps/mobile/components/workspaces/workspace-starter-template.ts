export type WorkspaceStarterTemplate = 'general-knowledge-worker';

// There is one starter kit — every managed workspace scaffolds with the full
// Kortix skill kit. (Kept as a helper so the create flow has a single source
// of truth for the `starter_template` it posts.)
export function starterTemplateForManagedWorkspace(): WorkspaceStarterTemplate {
  return 'general-knowledge-worker';
}
