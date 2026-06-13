import type { PageId } from './types';

/** Toggle individual demo tabs on/off. Disabled pages are hidden from the tab bar;
 *  the CLI skips `nav` beats to them (state `fx` beats still run). */
export const DEMO_PAGE_FLAGS: Record<PageId, boolean> = {
  home: false,
  projects: true,
  chat: true,
  agents: true,
  skills: true,
  integrations: true,
  models: true,
  scheduling: false,
  channels: true,
  security: false,
};

/** Canonical tab order before applying {@link DEMO_PAGE_FLAGS}. */
export const DEMO_PAGE_ORDER: PageId[] = [
  'home',
  'projects',
  'chat',
  'agents',
  'skills',
  'integrations',
  'models',
  'scheduling',
  'channels',
  'security',
];

export function isDemoPageEnabled(page: PageId): boolean {
  return DEMO_PAGE_FLAGS[page];
}

export const VISIBLE_DEMO_PAGES = DEMO_PAGE_ORDER.filter((id) => DEMO_PAGE_FLAGS[id]);

export function defaultDemoPage(): PageId {
  return VISIBLE_DEMO_PAGES[0] ?? 'projects';
}
