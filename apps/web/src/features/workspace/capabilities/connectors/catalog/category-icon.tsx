import {
  BriefcaseIcon,
  ChartBarIcon,
  ChatCircleIcon,
  CodeIcon,
  CurrencyDollarIcon,
  FolderIcon,
  GearIcon,
  LifebuoyIcon,
  MegaphoneIcon,
  PaletteIcon,
  ShoppingCartIcon,
  TrendUpIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import type { ComponentType } from 'react';

/**
 * A glyph per section, keyed by the FOLDED section key.
 *
 * The first block is one entry per `CURATED_SECTIONS` key, so every curated
 * heading is drawn deliberately. The second is a courtesy for the uncurated
 * tail — raw catalogue values no section claims but that turn up often enough
 * to be worth a glyph.
 *
 * Deliberately partial beyond that. The live catalogue publishes long-tail
 * categories nobody has drawn an icon for, and inventing a loose visual match
 * for each ("Malwarebytes" -> a shield?) would be worse than one honest
 * default. Anything unlisted gets `FolderIcon`.
 *
 * Its own module, not a constant inside `connector-browse.tsx`, because the
 * category rail and the section headings both draw these and a second copy
 * would let one of the two surfaces silently fall back to `FolderIcon` for a
 * category the other draws properly.
 */
const CATEGORY_ICON: Record<string, ComponentType<{ className?: string }>> = {
  // One per curated section, folded: `data-analytics` -> `dataanalytics`.
  popular: TrendUpIcon,
  productivity: BriefcaseIcon,
  operations: GearIcon,
  finance: CurrencyDollarIcon,
  dataanalytics: ChartBarIcon,
  communication: ChatCircleIcon,
  salesmarketing: MegaphoneIcon,
  customersupport: LifebuoyIcon,
  commerce: ShoppingCartIcon,
  contentdesign: PaletteIcon,
  developertools: CodeIcon,
  // Uncurated raw values common enough to be worth a glyph. `business` and
  // `businessmanagement` are what the live Easy Connect feed leads with, and
  // they sit in the tail rather than at the top.
  business: BriefcaseIcon,
  businessmanagement: BriefcaseIcon,
  hr: UsersIcon,
  humanresources: UsersIcon,
  analytics: ChartBarIcon,
  data: ChartBarIcon,
  marketing: MegaphoneIcon,
  sales: MegaphoneIcon,
  developer: CodeIcon,
  engineering: CodeIcon,
};

function categoryIcon(category: string): ComponentType<{ className?: string }> {
  return CATEGORY_ICON[category.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? FolderIcon;
}

/**
 * A category's glyph, as a component.
 *
 * A component rather than the bare `categoryIcon` lookup, because every caller
 * of the lookup has to write the same two lines — bind the result to a
 * capitalised local, then render it — and two copies of that is two chances for
 * one of them to size its glyph differently from the other. Callers now pass a
 * category and get the right glyph at the size they ask for.
 */
export function CategoryIcon({ category, className }: { category: string; className?: string }) {
  const Icon = categoryIcon(category);
  return <Icon className={className} />;
}
