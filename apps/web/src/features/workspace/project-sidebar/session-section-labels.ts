import { SESSION_SECTIONS } from './session-grouping';
export type SectionLabelKey = (typeof SESSION_SECTIONS)[keyof typeof SESSION_SECTIONS]['key'];
export function resolveSectionLabels(t: (key: SectionLabelKey) => string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(SESSION_SECTIONS).map(([id, section]) => [id, t(section.key)]),
  );
}
