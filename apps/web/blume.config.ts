import { defineConfig } from 'blume';

// The sidebar, in reading order. The Guide comes first: the A-to-Z journey
// of Kortix in plain language for business readers (founder, 2026-10-27).
// Every Guide page ends with "For developers"
// links into the technical reference, which follows under "Developers".
// Every page id must exist under content/docs; Blume renders a group's items
// in this exact order. This tree is the only nav source: content/docs has no
// meta.ts files.
const sidebar = [
  // The Guide is ONE scrollable page (content/docs/index.mdx, founder
  // 2026-10-27); these entries jump to its sections. Blume prefixes them
  // with the /docs base.
  { label: 'Guide', items: ['index', { label: 'Get started', href: '/#get-started' }] },
  {
    label: 'Build your AI OS',
    items: [{ label: 'Agents', href: '/#agents' }, { label: 'Skills', href: '/#skills' }, { label: 'Memory and Drive', href: '/#memory-and-drive' }, { label: 'Connectors', href: '/#connectors' }],
  },
  {
    label: 'Run it 24/7',
    items: [{ label: 'Automations', href: '/#automations' }, { label: 'Outcomes', href: '/#outcomes' }, { label: 'Computers', href: '/#computers' }, { label: 'Apps', href: '/#apps' }],
  },
  { label: 'Work where you are', items: [{ label: 'Channels', href: '/#channels' }, { label: 'Everywhere', href: '/#everywhere' }, { label: 'Models', href: '/#models' }] },
  { label: 'Teams and trust', items: [{ label: 'Teams', href: '/#teams' }, { label: 'Security', href: '/#security' }, { label: 'Billing', href: '/#billing' }] },
  // Less is more (founder, 2026-10-27): the technical reference is the few
  // pages a developer needs. Removed pages redirect to their Guide page
  // (next.config.ts). Kortix Capture's pages and the generated audit-actions
  // reference stay built but unlisted: the app links to them.
  {
    label: 'Developers',
    items: ['quickstart', 'git', 'project/manifest', 'cli', 'api', 'apps', 'host'],
  },
  { label: 'SDK', items: ['sdk', 'sdk/auth', 'sdk/sessions', 'sdk/react', 'sdk/ui', 'sdk/genui', 'sdk/reference'] },
];

// The docs render through Blume, not through the Next app. Nothing in
// content/docs may import an app component. Blume built-ins only.
export default defineConfig({
  title: 'Kortix',
  description: 'Open-source AI Operating System: your agents, skills, memory, and connectors in one repo you own. Any model. Self-host or cloud.',

  // Content stays where it has always been. src/lib/seo/public-content.ts
  // reads these same files off disk for /llms.txt, /markdown/docs/*.md and
  // /mcp, so moving them would break four public surfaces at once.
  content: { root: 'content/docs' },

  // The whole Blume site is served under /docs by the Next app, which maps
  // clean URLs onto public/docs/ with two afterFiles rewrites. `base`
  // rewrites internal links and asset hrefs to match.
  deployment: {
    base: '/docs',
    // Canonical URLs and OG image URLs need an absolute origin; without it
    // `blume audit` reports the site as non-indexable. Always the production
    // origin, including in dev builds — a canonical is meant to point at the
    // canonical home, not at whichever host rendered the page.
    // seo.sitemap stays false: the Next app owns /sitemap.xml for the whole
    // domain, so setting `site` must not hand that surface to Blume.
    site: 'https://kortix.com',
  },

  // "On this page" lists h2 only: the one-page Guide has 19 sections and
  // about 90 subheads.
  toc: { maxHeadingLevel: 2 },

  // Stock theme, deliberately. A Kortix skin is a separate follow-up; see
  // decision D3 in the spec. The accent is NOT set here: it is bound to the
  // foreground token in theme.css so it flips with the theme by itself.
  theme: {
    radius: 'md',
    mode: 'system',
  },
  logo: {
    href: '/docs',
    // 1.5.3 correction: light/dark/alt live under `image`, not top-level
    // `logo` — see task-4-report.md for the config-key corrections log.
    image: {
      // BOTH are symbol-only, the same 30x25 mark in black and white.
      // Blume renders the logo image and then a <span> with the site title
      // beside it, so the dark slot must NOT hold a full logomark: it used to
      // point at kortix-logomark-white.svg (708x142), which already contains
      // the wordmark, and dark mode printed "Kortix" twice while light was
      // correct. Keep both slots symbol-only.
      light: '/kortix-symbol.svg',
      dark: '/kortix-symbol-white.svg',
      // The adjacent site title names the link; the symbol is decorative.
      alt: '',
    },
  },

  // Search is the ONE surface Blume takes over, replacing /api/search and the
  // fumadocs dialog (spec section 6.4). The default provider builds a static
  // index at build time and queries it in the browser, with no API key and no
  // per-keystroke round trip — the same property the old dialog had. Left
  // unset deliberately: naming a provider here would opt into a hosted backend.
  //
  // Next owns every OTHER AI and SEO surface for the whole domain: marketing,
  // blog and docs in one index. Blume's duplicates would produce a second
  // llms.txt and a second MCP endpoint on the same host. See decision D2.
  // 1.5.3 correction: ai.mcp is an McpConfig object, not a boolean shorthand
  // — { enabled: false } is the 1.5.3 equivalent of `mcp: false`.
  // Reader-facing PDF export. Blume renders it via the browser's print
  // pipeline, so there is no server dependency and it works offline.
  export: { pdf: true },


  // Source repo. Powers the header repo link (navigation.repo) and the
  // per-page "Edit this page" target. `dir` is required because this is a
  // monorepo: the Blume project root is apps/web, not the repo root.
  github: {
    owner: 'kortix-ai',
    repo: 'suna',
    dir: 'apps/web',
  },

  seo: {
    // D2: the Next app owns every domain-wide discovery surface, and these two
    // contradicted it rather than merely duplicating it.
    //
    // robots — Blume emitted dist/robots.txt (served at /docs/robots.txt) with
    // `Content-Signal: ai-train=yes`. src/app/robots.txt, the real one, says
    // `ai-train=no`. Shipping a second robots that inverts the company's stated
    // AI-training position is worse than shipping none.
    //
    // agentReadability — dist/agent-readability.json carried the same
    // inversion as machine-readable JSON ("ai-train": true). /llms.txt already
    // advertises the markdown mirrors for the whole domain.
    robots: false,
    agentReadability: false,
    sitemap: false,
  },

  ai: {
    llmsTxt: false,
    mcp: { enabled: false },
    // "Open in chat" providers, in display order. Blume's default is all six;
    // v0, t3 and Scira are dropped because they are not tools this audience
    // reaches for. `openInChatProviders` in the installed package is a closed
    // enum, so "kortix" is added to it by patches/blume@1.5.3.patch, which also
    // carries the Kortix mark and the URL builder in PageActions.astro. The
    // Kortix link is ORIGIN-RELATIVE (/projects/start?q=…), so it resolves to
    // localhost in dev and kortix.com in production with nothing to configure.
    openInChat: ['kortix', 'chatgpt', 'claude', 'cursor'],
  },

  navigation: {
    // GitHub link in the header, after the search.
    repo: true,
    // Header tabs render immediately after the logo, before the spacer that
    // pushes search and the repo link right (Header.astro) — so this is the
    // extreme-left cluster. `path` is what scopes the sidebar and marks the
    // active tab; `href` overrides where a tab actually sends the reader, which
    // is how a tab can point off-site.
    tabs: [
      { label: 'Guide', path: '/' },
      {
        // The URL sits in `path`, not `href`. Blume validates every tab whose
        // path starts with "/" against the page tree and warns when nothing
        // matches — `/api-reference` is not a page here, so it warned on every
        // build. nav-diagnostics skips non-"/" paths outright, which is the
        // supported way to point a tab off-site. `href` would be redundant:
        // Header.astro renders `tab.href ?? tab.path`.
        label: 'API reference',
        path: 'https://api.kortix.com/v1/docs',
      },
    ],
    sidebar: { items: sidebar },
  },
});
