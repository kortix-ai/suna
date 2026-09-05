import { defineConfig, type FolderMetaDefinition } from 'blume';
import rootMeta from './content/docs/meta';
import connectMeta from './content/docs/connect/meta';
import featureFlagsMeta from './content/docs/feature-flags/meta';
import hostMeta from './content/docs/host/meta';
import projectMeta from './content/docs/project/meta';
import sdkMeta from './content/docs/sdk/meta';
import workMeta from './content/docs/work/meta';

// `defineMeta` accepts a plain object or an (async) factory
// (FolderMetaDefinition). Every meta.ts in this repo is a plain object
// literal, so resolving one here is always synchronous — this throws if that
// ever stops being true, rather than silently building a broken sidebar.
function resolveMeta(def: FolderMetaDefinition) {
  const resolved = typeof def === 'function' ? def() : def;
  if (resolved instanceof Promise) {
    throw new Error(
      'blume.config.ts navigation cannot resolve an async meta.ts factory synchronously',
    );
  }
  return resolved;
}

// Expands one directory's own meta.ts into an explicit sidebar group: its
// `index` page becomes the group's own link, every other page becomes
// `${dir}/${page}`. meta.ts stays the single source of truth for a section's
// title and page order — nothing here is re-typed.
function directoryGroup(dir: string, def: FolderMetaDefinition) {
  const meta = resolveMeta(def);
  return {
    label: meta.title ?? dir,
    items: (meta.pages ?? []).map((page) =>
      page === 'index' ? dir : `${dir}/${page}`,
    ),
  };
}

// Directories that have their own meta.ts and therefore expand into a
// labelled group instead of staying a bare page-id string.
const directoryMeta: Record<string, FolderMetaDefinition> = {
  project: projectMeta,
  work: workMeta,
  connect: connectMeta,
  'feature-flags': featureFlagsMeta,
  host: hostMeta,
  sdk: sdkMeta,
};

// The only ids fumadocs used to render under the "---Develop---" separator.
// This membership is not recorded anywhere else — it is the one piece of
// structure this config genuinely adds on top of content/docs/meta.ts.
const developIds = new Set(['cli', 'sdk', 'backend']);

const rootPages = resolveMeta(rootMeta).pages ?? [];

function toSidebarItem(id: string) {
  const dirMeta = directoryMeta[id];
  return dirMeta ? directoryGroup(id, dirMeta) : id;
}

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
  // Reader-facing PDF export. Blume renders it via the browser's print
  // pipeline, so there is no server dependency and it works offline.
  export: { pdf: true },

  // Locales mirror the Kortix web app exactly (src/i18n/config.ts:
  // ['en','de','it','zh','ja','pt','fr','es'], default 'en'), so a reader who
  // picks a language in the product finds the same set here.
  //
  // Blume ships built-in UI packs for all seven non-English locales, so the
  // chrome — search, navigation, page actions — is translated today. The docs
  // CONTENT is English-only, and `fallbackLocale: 'en'` is what makes that a
  // defined state rather than a set of empty pages: an untranslated page
  // renders its English source under the localized chrome. `blume translate`
  // fills them in later without any config change here.
  i18n: {
    defaultLocale: 'en',
    fallbackLocale: 'en',
    locales: [
      { code: 'en', label: 'English' },
      { code: 'de', label: 'Deutsch' },
      { code: 'it', label: 'Italiano' },
      { code: 'zh', label: '\u4e2d\u6587' },
      { code: 'ja', label: '\u65e5\u672c\u8a9e' },
      { code: 'pt', label: 'Portugu\u00eas' },
      { code: 'fr', label: 'Fran\u00e7ais' },
      { code: 'es', label: 'Espa\u00f1ol' },
    ],
  },

  // Source repo. Powers the header repo link (navigation.repo) and the
  // per-page "Edit this page" target. `dir` is required because this is a
  // monorepo: the Blume project root is apps/web, not the repo root.
  github: {
    owner: 'kortix-ai',
    repo: 'suna',
    dir: 'apps/web',
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
  seo: { sitemap: false },

  // The old fumadocs root meta.json carried a "---Develop---" separator
  // splitting cli/sdk/backend (+ an external API-reference link) from the
  // rest, plus that external link itself. Blume's meta.ts `pages` field is a
  // plain string array (folderMetaSchema.pages: ZodArray<ZodString> in
  // node_modules/blume/dist/types/core/schema.d.ts) — no divider or link
  // syntax. `navigation.links` and `navigation.cta`/`navigation.actions`
  // (suggested by useblume.dev, which documents 1.6.0) do NOT exist on this
  // installed 1.5.3's NavigationConfig (config-input.d.ts only has
  // featured/repo/selectors/sidebar/tabs).
  //
  // Fix: an explicit `navigation.sidebar.items` tree (SidebarItemConfig in
  // schema.d.ts — a page-id string, or an object with label/href/items) can
  // express a labelled group and an external link without moving any content
  // file, so cli.mdx, sdk/ and backend.mdx keep their /docs/cli, /docs/sdk,
  // /docs/backend URLs.
  //
  // config-input.d.ts:374 — "Omit `items` to generate the sidebar from the
  // content tree; provide `items` for a fully explicit sidebar" — is
  // all-or-nothing. A first attempt gave directory entries (project, work,
  // connect, feature-flags, host, sdk) as bare id strings with no nested
  // `items`, which built and looked right at the top level but orphaned
  // every one of that directory's OWN sub-pages from the sidebar: sdk/apps
  // and sdk/sign-in built fine at their URLs but rendered in 0 sidebar
  // entries (`grep -c` on the built HTML, not a rendering-timing issue).
  // Auto mode (no `navigation` block, or `navigation.featured` for the
  // external link) renders every page but reorders the top level to
  // files-then-directories, which cannot reproduce the interleaved original
  // order. Full, byte-verified fix: every directory entry needs its own
  // nested `items:` listing every one of its sub-pages, confirmed against a
  // real `blume build` with 0 missing pages and the exact target order.
  //
  // Full nesting means every directory's title + page list would otherwise
  // be duplicated between its meta.ts and this file (9 top-level entries ->
  // 36 nested ones). `directoryGroup`/`toSidebarItem` above avoid that by
  // reading each directory's title and page order directly out of its own
  // meta.ts module — this file adds only the one thing meta.ts cannot
  // express: which ids sit under "Develop", and the external link.
  navigation: {
    // GitHub link in the header, after the search.
    repo: true,
    // Header tabs render immediately after the logo, before the spacer that
    // pushes search and the repo link right (Header.astro) — so this is the
    // extreme-left cluster. `path` is what scopes the sidebar and marks the
    // active tab; `href` overrides where a tab actually sends the reader, which
    // is how a tab can point off-site.
    tabs: [
      { label: 'Docs', path: '/' },
      {
        label: 'API reference',
        path: '/api-reference',
        href: 'https://api.kortix.com/v1/docs',
      },
    ],
    sidebar: {
      items: [
        ...rootPages.filter((id) => !developIds.has(id)).map(toSidebarItem),
        {
          label: 'Develop',
          // The API reference used to sit here as a sidebar link. It is a
          // header tab now, so listing it twice would be two routes to the
          // same off-site page from one screen.
          items: rootPages.filter((id) => developIds.has(id)).map(toSidebarItem),
        },
      ],
    },
  },
});
