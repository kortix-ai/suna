import { defineConfig } from 'blume';

// The docs render through Blume, not through the Next app. Nothing in
// content/docs may import an app component. Blume built-ins only.
export default defineConfig({
  title: 'Kortix',
  description: 'Kortix is the AI command center for your company.',

  // Content stays where it has always been. src/lib/seo/public-content.ts
  // reads these same files off disk for /llms.txt, /markdown/docs/*.md and
  // /mcp, so moving them would break four public surfaces at once.
  content: { root: 'content/docs' },

  // The whole Blume site is served under /docs by the Next app, which maps
  // clean URLs onto public/docs/ with two afterFiles rewrites. `base`
  // rewrites internal links and asset hrefs to match.
  deployment: { base: '/docs' },

  // Stock theme, deliberately. A Kortix skin is a separate follow-up; see
  // decision D3 in the spec. Only the logo and accent are set here.
  theme: {
    accent: 'teal',
    radius: 'md',
    mode: 'system',
  },
  logo: {
    href: '/docs',
    // 1.5.3 correction: light/dark/alt live under `image`, not top-level
    // `logo` — see task-4-report.md for the config-key corrections log.
    image: {
      light: '/kortix-symbol.svg',
      dark: '/kortix-logomark-white.svg',
      alt: 'Kortix',
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
  ai: { llmsTxt: false, mcp: { enabled: false } },
  seo: { sitemap: false },
});
