# @kortix/ui

The shared React component library for `apps/web`, Kortix Apps, the
white-label demo and SDK hosts. Components are Tailwind v4 class strings themed
by CSS variables. The whole session UI lives here, one module per
responsibility (layout below). `apps/web` imports it like any host: the module
entries, the primitives, and a short list of deep paths (below).

**Built with @kortix/ui:** [Lumen](../../apps/whitelabel-demo), a complete white-label agent
product in its own brand. Every screen is a module of this package.

<p align="center"><img src="https://github.com/kortix-ai/suna/raw/dev/apps/whitelabel-demo/public/screenshots/session.png" width="720" alt="Lumen: the Kortix session workspace in Lumen's brand" /></p>

Install: not on npm yet. Inside kortix-ai/suna: `"@kortix/ui": "workspace:*"`.
After the first npm release: `npm i @kortix/ui`.
`react` and `react-dom` 19 are peers (the PowerPoint preview needs React 19.2.7 or later).

- Public docs: `apps/web/content/docs/sdk/ui.mdx` (https://kortix.com/docs/sdk/ui).
- Agent skill: `skills/kortix-ui/SKILL.md`, with `references/custom-dashboard.md`
  (a whole dashboard), `references/modules.md` (every entry, its props, an example) and
  `references/theming.md` (every theme key). Kortix sessions load the same files
  from `packages/starter/templates/managed/skills/kortix-ui/SKILL.md`
  (`kortix-ui` is in `KORTIX_MANAGED_SKILL_NAMES`, so the sandbox bake ships it).
  `src/skill.test.ts` fails when the copies (SKILL.md and `references/`) differ,
  or when the skill's Components table (root, theme) or `references/modules.md`
  (every module entry) misses an export.
- Live catalog: the `/design-system` route of `apps/web`.

## Use it

Tailwind host (apps/web, a Vite App with Tailwind):

```css
@import 'tailwindcss';
@import '@kortix/ui/tailwind.css';
```

Install the plugins `tailwind.css` loads (optional peers, so a host without
Tailwind never installs Tailwind):
`npm i tw-animate-css tailwind-scrollbar tailwind-scrollbar-hide`.

`tailwind.css` imports `tw-animate-css`, `tokens.css` (the `:root` / `.dark`
values), `theme.css` (dark variant, base rules, `@theme` keys, utilities,
keyframes, `@source` over the package) and the `tailwind-scrollbar` plugins.
A host that brings its own token values imports the parts one by one. Every
line except `tokens.css` is required: without `tw-animate-css` and the plugins,
overlay animations and `scrollbar-hide` drop out with no build error.

```css
@import 'tailwindcss';
@import 'tw-animate-css';
@import '@kortix/ui/tokens.css'; /* optional */
@import '@kortix/ui/theme.css';
@plugin 'tailwind-scrollbar';
@plugin 'tailwind-scrollbar-hide';
```

`tokens.css` sets `--spacing: 0.23rem`, 8% tighter than Tailwind's `0.25rem`.
The host's own spacing utilities follow it (`p-4` is 14.72px). To keep stock
Tailwind spacing, set `--spacing: 0.25rem` after the import; the components
then render 8% larger.

`theme.css` holds the base rules every host needs: `body` paints
`--background` / `--foreground`, `*` borders default to `--border`,
`color-scheme` follows `.dark`, `::selection` reads `--selection`, and
interactive elements get the pointer cursor.

Host without Tailwind: `import '@kortix/ui/styles.css'`. It is
`dist/styles.css`, committed and rebuilt by `pnpm --filter @kortix/ui
build:styles` after any change under `src/`. `src/exports.test.ts` fails when
the committed file drifts from a fresh build.

Kortix-owned surfaces only (brand D8a): `@import '@kortix/ui/fonts.css';`
after `theme.css` loads Roobert and sets `--font-roobert` /
`--font-roobert-mono`. A white-label host never imports it.

## Host adapters

Mount `UiProvider` once at the root. Every prop is optional. A host without
any prop gets these defaults:

| Prop | Default without it |
| --- | --- |
| `strings` | English copy (`defaultUiStrings`) |
| `link` | a plain `<a>`: every link is a full page load |
| `image` | a plain `<img>` |
| `navigation` | `defaultUiNavigation`: `push` / `replace` are full page loads, `usePathname` / `useSearchParams` read `window.location`, `useParams` returns `{}` |
| `i18n` | the bundled English catalog of `@kortix/ui/i18n` |
| `useViewerId` | no signed-in user (`undefined`): a one-person session names no sender and no "Stopped by". A session several people write in needs it |
| `useBrand` | the Kortix marks |
| `config` | `{ connectorsEnabled: true, managedModelsEnabled: false, terminalEnabled: true, commandPaletteShortcut: false, settingsShortcut: false }`. The two shortcut flags say the host opens a command palette on ⌘K or settings on ⌘,; only then does the composer hint at them. `config.providerIconBaseUrl`: where the host serves provider logos (`<base>/<icon>.svg`); without it they load from models.dev, and the Kortix provider draws `useBrand`'s icon. Billing is the SDK flag `configureKortix({ billingEnabled })`, which every billing gate reads. It is for Kortix's own app: its upgrade actions open the Kortix plan dialog that apps/web mounts. A custom host leaves it off, so no upgrade control renders. |
| `components` | no slots: a control that opens a missing slot is hidden (`ShareSessionModal`, `HomeAnnouncement`, `Wallpaper`, `ProjectProviderModal`, `ProviderAccountsModal`, `ConnectorConnectModal`) |

`strings` takes any subset of `UiStrings`. `MermaidRenderer`'s controls are
English only.

A host without a router or i18n (plain Vite, a CDN page):

```tsx
import { UiProvider } from '@kortix/ui';
<UiProvider>{app}</UiProvider>
```

A Next.js host passes its own hooks. Pass stable objects (module level):

```tsx
import { UiProvider, type UiNavigation } from '@kortix/ui';
import type { UiI18nHost } from '@kortix/ui/i18n';
import NextImage from 'next/image';
import NextLink from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

const navigation: UiNavigation = { useRouter, usePathname, useSearchParams, useParams };
const i18n: UiI18nHost = { useTranslations, useLocale };
const useViewerId = () => useAuth().user?.id;

<UiProvider
  strings={{ confirm: t('confirm'), chat: { model: t('model') } }}
  link={NextLink}
  image={NextImage}
  navigation={navigation}
  i18n={i18n}
  useViewerId={useViewerId}
  config={{ managedModelsEnabled: true }}
>
  {app}
</UiProvider>
```

`image={NextImage}` needs `images.remotePatterns` for every remote logo URL.

The session UI reads the project and session it renders from
`SessionIdsProvider`, never from route params. `SessionThread`,
`SessionWorkspace` and `ProjectHome` mount it themselves, together with the
SDK's project scope (`internal/project-scope.tsx`). Around any other block,
mount `KortixProjectProvider` (`@kortix/sdk/react`) and
`<SessionIdsProvider projectId={projectId} sessionId={sessionId}>`.
`useSessionIds()` reads it; without a provider both ids are `undefined`, and
components that need them render nothing. The root entry imports nothing from
`@kortix/sdk`: `scripts/build.mjs` loads `dist/providers/session-ids.js` in
plain Node to keep it so.

Telemetry is module level, so plain functions report too. Call
`setUiTelemetry` once at module load; omitted functions keep their default
(`track`, `captureMessage`, `addBreadcrumb` do nothing; `captureException`
logs to the console):

```ts
import { setUiTelemetry } from '@kortix/ui/lib/telemetry';

declare module '@kortix/ui/lib/telemetry' {
  interface UiTelemetryRegister { event: 'panel_opened' | 'panel_closed' } // optional: tsc checks event names
}
setUiTelemetry({ track: (event, properties) => analytics.capture(event, properties) });
```

Translations: `@kortix/ui/i18n` exports `useTranslations` and `useLocale`
(the next-intl signatures: `t`, `t.rich`, `t.markup`, `t.raw`, `t.has`),
`UiI18nHost`, `UiTranslator`, `UiMessages`, `defaultUiMessages` (the English
catalog, generated by `pnpm --filter @kortix/ui gen-i18n-catalog`) and
`createTranslator`. `i18n={{ locale, messages }}` replaces the catalog
without host hooks. The catalog ships in every bundle that imports
`@kortix/ui/i18n` (about 121 kB minified, 46 kB gzip), also when the host
passes its own hooks.

Two more host-free helpers: `lazyClient(load, { fallback })`
(from the `@kortix/ui` root) loads a component on the client only, the
`next/dynamic(..., { ssr: false })` contract. `ErrorBoundary` and
`ErrorBoundaryFallback` (`@kortix/ui/error-boundary`) report to
`captureException`.

Dark mode is the `dark` class on `<html>` (`useIsDark()` reads it).

Import components by subpath: `import { Button } from '@kortix/ui/button'`.
The root `@kortix/ui` barrel holds only light core primitives. Toasts need one
`<Toaster />` from `@kortix/ui/toast` at the root; `IconProvider`
(`@kortix/ui/icon-provider`) sets the house icon weight.

### Routes

Every URL the components link to comes from one route table, `setUiRoutes` (`@kortix/ui`), called once at module load. The defaults are Kortix's own paths: `project` `/projects/<id>`, `session` `/projects/<id>/sessions/<sessionId>`, `sessions` `/projects/<id>/sessions` (`?view=archived|deleted`), `files` `/projects/<id>/files`, `drive` `/projects/<id>/drive`, `apps` `/projects/<id>/apps`, `members` `/projects/<id>/members`, `sandboxSettings` `/projects/<id>/config?section=sandbox`, `customize` `/projects/<id>/customize/<page>` (agents, skills, connectors, triggers, reminders, models, secrets, review, settings). Return your own path for a page you serve elsewhere. Return `null` for a page you do not serve: every link to it is hidden. `project` and `session` cannot be null.

## Modules

Every part of a Kortix session is a module with one entry. Its curated names
are the public API (semver). Each needs `@kortix/sdk` and `@tanstack/react-query`
5 (an optional peer, shared with the host so both read one `QueryClient`: the bundler
fails without it, npm does not warn), one
`QueryClientProvider`, and, for the thread, `@openuidev/lang-core@0.3.1` and `zod`:
`npm i @kortix/ui @kortix/sdk @tanstack/react-query @openuidev/lang-core@0.3.1 zod`.

| Entry | What it is | Minimal mount |
| --- | --- | --- |
| `./workspace` | `SessionWorkspace` (thread + resizable side panel), `ProjectHome`, `ProjectSessionList`, `ProjectFilesView`, `ShareSessionModal` | `<SessionWorkspace session={useSession(p, s)} />` |
| `./session` | `SessionThread`, turns, `ToolRegistry`, prompts, pickers | `<SessionThread session={useSession(p, s)} />` |
| `./composer` | `ComposerChatInput` and the send pipeline | in the project scope |
| `./session-panel` | `SessionPanelProvider`, `ActionPanel`, `SessionFiles`, `SessionChanges` | `SessionPanelProvider` |
| `./files`, `./file-viewer` | project and sandbox files, `FilePreviewHost`; `FileViewer`, `FileContentRenderer` | `ProjectFilesView`; `<FileViewer content fileName />` |
| `./terminal`, `./browser` | `SessionTerminal`; `SessionBrowser`, `BrowserLanding` | a mounted session's runtime ids |
| `./markdown`, `./genui`, `./diff`, `./changes` | `UnifiedMarkdown`, GenUI blocks, `DiffView`, `ChangeList` | none |
| `./apps`, `./access`, `./customize` | App frames; sharing and roles; project configuration pages | `projectId` |
| `./theme`, `./i18n`, `./icons` | the typed theme; translations; glyphs | none |

```tsx
import { useSession } from '@kortix/sdk/react';
import { SessionWorkspace } from '@kortix/ui/workspace';

export function Session({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return <SessionWorkspace session={useSession(projectId, sessionId)} />;
}
```

`SessionThread` alone shows file and preview opens in a dialog when no side
panel is mounted. `ProjectHome` sends by itself (creates the session with the
prompt and navigates to `/projects/<id>/sessions/<sessionId>`); `beforeSend`
gates it. `ToolRegistry.register('<tool>', Row)` replaces a tool row.

Compose a custom workspace at any depth: your own column inside
`SessionWorkspace` (`children`), the panel alone (`SessionPanelProvider` +
`ActionPanel`), single blocks inside `KortixProjectProvider` +
`SessionIdsProvider`, or every part yourself with `renderParts` from
`@kortix/sdk/react`.

Deep paths have no semver. `@kortix/ui/internal/*` and
`@kortix/ui/<module>/<path>` exist only for the files Kortix's own apps import
(`scripts/deep-exports.json`). A host imports the entries and the primitives.

A whole dashboard (client, router adapters, theme, sidebar with the session
list, project home, session workspace, Files page, custom tool row, App
sign-in): `skills/kortix-ui/references/custom-dashboard.md`. Its samples are
copies of a Vite + React 19 app that type-checks, builds and runs against a
live API. Every entry with its props and an example: `references/modules.md`.

## Layout

`src/<module>/` holds one responsibility each. A file imports its own module or
a lower layer; `internal` has no public entry and no semver.

| Layer | Module | Entry |
| --- | --- | --- |
| 0 | `lib`, `hooks`, `icons`, `providers`, `i18n`, `theme`, `styles`, `types` | `.`, `./icons`, `./i18n`, `./theme` |
| 1 | `primitives`: the design-system components | `./<name>` per file |
| 2 | `internal`: stores, hooks, helpers, the sandbox file data layer, share and layout bits | none |
| 3 | `markdown` (with `genui`, `setup-links`), `diff` | `./markdown`, `./genui`, `./diff` |
| 4 | `changes`, `files` (`tree`, `runtime`, `project`, `viewer`, `renderers`, `editor`, `drives`), `terminal`, `apps`, `browser`, `access` | `./changes`, `./files`, `./file-viewer`, `./terminal`, `./apps`, `./browser`, `./access` |
| 5 | `session` (`thread`, `turn`, `composer`, `tool`, `prompts`, `status`, `models`, `header`, `actions`, `scope`, `overrides`, `print`, `media`, `outcomes`, `pickers`, `panel`) | `./session`, `./composer`, `./session-panel` |
| 6 | `customize`: project configuration pages | `./customize` |
| 7 | `workspace`: composed screens | `./workspace` |

"Sandbox files" are a live session's workspace (`files/runtime`); "project
files" are the git-backed repo (`files/project`). Each entry is an explicit
barrel (no `export *`), listed in `scripts/gen-exports.mjs` `ENTRIES`. Every
other module file is reachable through its entry only. A deep key
(`./<module>/<path>`, no semver) exists for each file in
`scripts/deep-exports.json`: the module files apps/web, the white-label demo and
the repo tests import today. `tests/unit/ui-deep-exports.test.ts` keeps that list
equal to the imports, so a new deep import is a deliberate edit.

## Theming

`@kortix/ui/theme` is the typed theme API. Every field is optional; an unset
field keeps the Kortix default, and a `dark` color falls back to the Kortix dark
default, never to the `light` value.

```tsx
import { themeToCss, ThemeScope, type KortixTheme } from '@kortix/ui/theme';

const brand: KortixTheme = {
  light: { blue: '#4f46e5', ring: '#4f46e5', border: '#e0e7ff' },
  dark: { blue: '#818cf8', ring: '#818cf8', border: '#312e81' },
  radius: '0.25rem',
  fonts: { sans: 'Inter, system-ui, sans-serif' },
};

<style>{themeToCss(brand)}</style>            // the whole app (server-safe)
<ThemeScope theme={brand}>…</ThemeScope>     // one subtree; its overlays portal into it
```

| Field | Variables | Controls |
| --- | --- | --- |
| `light`, `dark` | `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive` (+ `*-foreground`), `--border`, `--input`, `--ring`, `--focus-ring`, `--hover`, `--active`, `--selection`, `--sidebar-*`, `--kortix-*`, `--chart-*`, `--terminal-*`, any `--custom` | Colors per mode. `blue` (`--kortix-blue`) is the accent; `ring` is focus; `primary` is ink |
| `radius` | `--radius` | Every `rounded-*` derives from it (`rounded` −6px … `2xl` +6px) |
| `spacing` | `--spacing` | Density of every `p-*`, `m-*`, `gap-*`, `size-*` |
| `fonts.sans`, `fonts.mono` | `--font-family-sans`, `--font-family-mono` | Body and headings; code and ids |
| `text`, `lineHeights` | `--text-<step>`, `--text-<step>--line-height` | The type scale |
| `shadows` | `--shadow-<step>` | Elevation; `0 0 #0000` flattens a step |
| `durations`, `easing` | `--duration-*`, `--ease-*` | Motion |
| `vars` | any `--name` | Anything else, both modes |

`THEME_COLOR_VARS` maps each color key to its variable. Plain CSS works too:
set the same variables in your own `:root` / `.dark` after the import. Never
fork a component. Roobert (`--font-roobert`) is for Kortix-owned surfaces only.
`apps/whitelabel-demo/src/config/theme.ts` is the reference.

How it stays themable:

- `theme.css` maps every Tailwind key to a variable. Steps that share a name
  with their variable (`--text-sm`, `--shadow-md`, `--ease-default`, bare
  `rounded`) live in `@theme inline reference`, so Tailwind never emits the
  `--x: var(--x)` cycle into `:root`.
- Every Radix portal goes through `withPortalContainer`
  (`src/lib/portal-container.tsx`). Without a `ThemeScope` it portals to
  `document.body`, as before.
- A new component reads tokens only: no hex, no palette class, no fixed
  radius. `apps/web` must look identical: every new variable defaults to the
  value it replaces.

## Known issues

- Server rendering: the entries that render sessions or files (`session`, `composer`, `session-panel`, `workspace`, `files`, `file-viewer`, `markdown`, `genui`, `customize`) import CSS (KaTeX and others) from JS, so plain Node cannot evaluate them (`ERR_UNKNOWN_FILE_EXTENSION ".css"`). A Vite SSR host adds `ssr: { noExternal: ['@kortix/ui'] }`. A Next.js host lists `@kortix/ui` in `transpilePackages`. Or load those blocks on the client only (`lazyClient`). The root, `theme`, `i18n`, `icons`, `diff`, `changes`, `terminal`, `browser`, `apps` and `access` entries evaluate in Node.
- `cmdk@0.2.1` declares a React 18 peer and nests `@radix-ui/react-dialog@1.0.0`.
  `Command` works on React 19. A host with `strict-peer-dependencies` must allow
  `cmdk`'s React peer. `cmdk` 1.x
  changes the selection model `command.tsx` is tuned to, and `apps/web` imports
  `cmdk` directly, so the upgrade is its own change.

## Rules

- Values: the `kortix-brand` skill (`.agents/skills/kortix-brand/SKILL.md`).
  The generator is `.agents/skills/kortix-brand/scripts/generate-tokens.ts`.
- Components: the `kortix-design-system` skill.
- Imports inside the package are relative. Never import `apps/web` code.
- `@kortix/shared` and `@kortix/manifest-schema` are private: they are
  devDependencies, and `scripts/build.mjs` inlines what dist imports from them.
- Edit a component here. `apps/web` keeps no re-export shims
  (`tests/unit/web-no-ui-shims.test.ts`); it imports `@kortix/ui/<name>` or the entry.
- `package.json` `exports` is generated: `pnpm --filter @kortix/ui gen-exports`.
  `src/exports.test.ts` fails on drift and on an export target that does not exist.
- `src/styles/tokens.css`, `src/styles/fonts.css` and the `theme` region of
  `src/styles/theme.css` are generated. `dist/styles.css` is built. Never edit them by hand.

## Checks

```sh
pnpm --filter @kortix/ui typecheck
pnpm --filter @kortix/ui test src/exports.test.ts   # exports map, targets, dist/styles.css drift
pnpm --filter @kortix/ui test src/skill.test.ts     # skill names every barrel export; managed copy identical
bun .agents/skills/kortix-brand/scripts/generate-tokens.ts --check
.agents/skills/kortix-brand/scripts/audit.sh packages/ui/src
```
