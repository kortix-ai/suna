// The docs are two scrolling pages (founder, 2026-10-28): the Guide at
// /docs/guide (content/docs/guide.mdx) and Developers at /docs/developers
// (content/docs/developers.mdx), one header tab each; /docs is a landing page.
// This list is both outlines, one link per top-level section. The "/guide/"
// and "/developers/" prefixes (Blume adds the /docs base) say which page an
// entry belongs to.
//
// blume.config.ts passes it to Blume as the sidebar, and
// OutlineSidebar.astro reads it directly to render the left-hand "On this
// page": Blume scopes the sidebar items it hands the slot to the active tab,
// and a link entry never counts as under a tab, so that prop arrives empty.
// Kortix Capture's pages and the generated audit-actions reference stay built
// but unlisted: the app links to them.
export const OUTLINE = [
  {
    label: 'Start',
    items: [
      { label: 'Overview', href: '/guide/#how-it-works' },
      { label: 'How the pieces fit', href: '/guide/#how-the-pieces-fit' },
      { label: 'Get started', href: '/guide/#get-started' },
    ],
  },
  {
    label: 'Building blocks',
    items: [
      { label: 'Agents', href: '/guide/#agents' },
      { label: 'Skills', href: '/guide/#skills' },
      { label: 'Apps', href: '/guide/#apps' },
      { label: 'Drive', href: '/guide/#drive' },
      { label: 'Connectors', href: '/guide/#connectors' },
      { label: 'Automations', href: '/guide/#automations' },
      { label: 'Computers', href: '/guide/#computers' },
      { label: 'Models', href: '/guide/#models' },
    ],
  },
  {
    label: 'Run it',
    items: [
      { label: 'Outcomes', href: '/guide/#outcomes' },
      { label: 'Channels', href: '/guide/#channels' },
      { label: 'Everywhere', href: '/guide/#everywhere' },
      { label: 'Teams', href: '/guide/#teams' },
      { label: 'Security', href: '/guide/#security' },
      { label: 'Billing', href: '/guide/#billing' },
    ],
  },
  {
    label: 'Developers',
    items: [
      { label: 'Quickstart', href: '/developers/#quickstart' },
      { label: 'Git', href: '/developers/#git' },
      { label: 'kortix.yaml reference', href: '/developers/#kortixyaml-reference' },
      { label: 'CLI', href: '/developers/#cli' },
      { label: 'REST API', href: '/developers/#rest-api' },
      { label: 'Apps reference', href: '/developers/#apps-reference' },
      { label: 'Self-hosting', href: '/developers/#self-hosting' },
    ],
  },
  {
    label: 'SDK',
    items: [
      { label: 'SDK', href: '/developers/#sdk' },
      { label: 'Authentication', href: '/developers/#sdk-authentication' },
      { label: 'Sessions from code', href: '/developers/#sessions-from-code' },
      { label: 'Projects from code', href: '/developers/#projects-from-code' },
      { label: 'React', href: '/developers/#react' },
      { label: 'Generative UI', href: '/developers/#generative-ui' },
      { label: 'Kortix UI', href: '/developers/#kortix-ui' },
      { label: 'SDK reference', href: '/developers/#sdk-reference' },
    ],
  },
];
