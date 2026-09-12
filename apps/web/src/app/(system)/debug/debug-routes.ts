/**
 * Every harness under /debug, as listed on the /debug index.
 *
 * `debug-routes.test.ts` compares this list with the folders next to it. Add a
 * `page.tsx` folder without an entry here, or leave an entry whose folder is
 * gone, and the test fails.
 */

export type DebugRouteGroup = 'Session' | 'Components' | 'Screens';

export type DebugRoute = {
  /** Folder name under `src/app/(system)/debug/`. */
  slug: string;
  group: DebugRouteGroup;
  title: string;
  description: string;
};

export const DEBUG_ROUTE_GROUPS: DebugRouteGroup[] = ['Session', 'Components', 'Screens'];

export const DEBUG_ROUTES: DebugRoute[] = [
  {
    slug: 'turn',
    group: 'Session',
    title: 'Turn',
    description:
      'An assembled turn: burst collapse, title generation, the user card, and the plan card.',
  },
  {
    slug: 'tools',
    group: 'Session',
    title: 'Tools',
    description: 'Every core tool renderer in running, completed, error, and empty states.',
  },
  {
    slug: 'minimap',
    group: 'Session',
    title: 'Minimap',
    description: 'The jump rail beside a turn: dash taper, preview card, and mention chips.',
  },
  {
    slug: 'thinking',
    group: 'Session',
    title: 'Thinking',
    description:
      'The busy indicator in every mode: default, rotation, locked status, retry, and elapsed.',
  },
  {
    slug: 'permissions',
    group: 'Session',
    title: 'Permissions',
    description: 'The permission prompt with short, long, and multiline commands.',
  },
  {
    slug: 'approvals',
    group: 'Session',
    title: 'Approvals',
    description: 'The connector approval card inside the real composer strip.',
  },
  {
    slug: 'system-message',
    group: 'Session',
    title: 'System message',
    description: 'System message variants, and the notification cards parsed from real tags.',
  },
  {
    slug: 'split-sheet',
    group: 'Components',
    title: 'Split sheet',
    description: 'The in-layout sheet in phone, tablet, and desktop frames, at every size.',
  },
  {
    slug: 'sharing',
    group: 'Components',
    title: 'Sharing picker',
    description: 'The sharing picker with a seeded member list and no API calls.',
  },
  {
    slug: 'tabs',
    group: 'Components',
    title: 'Tabs',
    description: 'The sliding tab indicator, inline and inside a modal that zooms in.',
  },
  {
    slug: 'dot-matrix',
    group: 'Components',
    title: 'Dot matrix',
    description: 'Every busy-indicator glyph, grouped by family.',
  },
  {
    slug: 'file-preview',
    group: 'Components',
    title: 'File preview',
    description: 'The file viewer on a stub source: markdown toggle and thumbnail sizing.',
  },
  {
    slug: 'connecting',
    group: 'Screens',
    title: 'Connecting',
    description: 'Every connecting screen variant, outside dashboard gating.',
  },
  {
    slug: 'error',
    group: 'Screens',
    title: 'Error',
    description:
      'The system fault screen with preset crashes, including a long message and no stack.',
  },
  {
    slug: 'marketplace',
    group: 'Screens',
    title: 'Marketplace',
    description: 'The marketplace view with a stub auth token.',
  },
  {
    slug: 'wallpaper',
    group: 'Screens',
    title: 'Wallpaper',
    description:
      'The full-bleed wallpaper render the exporter captures. Reads id, theme, and px query params.',
  },
];
