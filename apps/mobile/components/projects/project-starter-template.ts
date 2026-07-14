export type ProjectStarterTemplate = 'general-knowledge-worker';

// There is one starter kit — every managed project scaffolds with the full
// Kortix skill kit. (Kept as a helper so the create flow has a single source
// of truth for the `starter_template` it posts.)
export function starterTemplateForManagedProject(): ProjectStarterTemplate {
  return 'general-knowledge-worker';
}
