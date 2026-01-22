export const PREVIEW_CONFIG = {
  useDocsPreview: true,
  useResearchPreview: true,
  useDataPreview: true,
  usePeoplePreview: true,
} as const;

/**
 * Quick toggle to disable ALL visual previews and revert to icons
 * Set this to true to override all individual settings above
 */
export const USE_LEGACY_ICONS = false;

export function shouldUseVisualPreview(mode: 'docs' | 'research' | 'data' | 'people'): boolean {
  if (USE_LEGACY_ICONS) return false;
  
  switch (mode) {
    case 'docs':
      return PREVIEW_CONFIG.useDocsPreview;
    case 'research':
      return PREVIEW_CONFIG.useResearchPreview;
    case 'data':
      return PREVIEW_CONFIG.useDataPreview;
    case 'people':
      return PREVIEW_CONFIG.usePeoplePreview;
    default:
      return false;
  }
}
