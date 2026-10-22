'use client';

const KNOWN_COMPANY_LABELS: Record<string, string> = {
  kortix: 'Kortix',
  'anthropics/skills': 'Anthropic Skills',
  'anthropics/knowledge-work-plugins': 'Anthropic Knowledge Work',
};

export function displayCompanyLabel(marketplaceId: string, label?: string): string {
  if (label && label !== marketplaceId) return label;
  return KNOWN_COMPANY_LABELS[marketplaceId] ?? marketplaceId;
}
