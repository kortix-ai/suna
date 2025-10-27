/**
 * Quick Action Translation Helper
 * 
 * Maps quick action option IDs to translation keys
 */

export function getQuickActionOptionTranslationKey(actionId: string, optionId: string): string {
  const categoryMap: Record<string, string> = {
    'image': 'imageStyles',
    'slides': 'slidesTemplates',
    'data': 'dataTypes',
    'docs': 'documentTypes',
    'people': 'peopleTypes',
    'research': 'researchSources',
  };

  const category = categoryMap[actionId];
  if (!category) {
    return optionId; // Fallback to option ID
  }

  return `quickActions.${category}.${optionId}`;
}

