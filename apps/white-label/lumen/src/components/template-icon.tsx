import { ChartLineUpIcon, MagnifyingGlassIcon, ScalesIcon } from '@phosphor-icons/react';

const ICONS = {
  'finance-analyst': ChartLineUpIcon,
  'legal-reviewer': ScalesIcon,
  research: MagnifyingGlassIcon,
} as const;

/** The icon of an agent template (convex/templates.ts). Unknown slugs get the research glyph. */
export function templateIcon(slug: string) {
  return ICONS[slug as keyof typeof ICONS] ?? MagnifyingGlassIcon;
}
