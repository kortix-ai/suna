import type { CustomizeSection } from '@/lib/customize-sections';
import type { RailItem } from './type';

/**
 * Whether a rail item is the active one for the current section.
 *
 * `llm-management` stands in for every `llm-*` sub-section so deep-links into
 * an LLM sub-page still light up the single LLM rail entry. Every other item —
 * including the independent Agents, Skills, and Commands entries — matches its
 * own section 1:1.
 */
export function isRailItemActive(item: RailItem, section: CustomizeSection): boolean {
  if (item.section === 'llm-management') return section.startsWith('llm-');
  return item.section === section;
}
