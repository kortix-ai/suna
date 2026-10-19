# @kortix/ui

The shared React component library for `apps/web`, Kortix Apps, the
white-label demo and SDK hosts. Components are Tailwind v4 class strings themed
by CSS variables. Every `apps/web/src/components/ui/<name>` file lives here as
`src/components/ui/<name>.tsx`; `apps/web` keeps a one-line re-export shim at
each old path.

Install: not on npm yet. Inside kortix-ai/suna: `"@kortix/ui": "workspace:*"`.
After the first npm release: `npm i @kortix/ui`.
`react` and `react-dom` 18 or later are peers.

- Public docs: `apps/web/content/docs/sdk/ui.mdx` (https://kortix.com/docs/sdk/ui).
- Agent skill: `skills/kortix-ui/SKILL.md`. Kortix sessions load the same file
  from `packages/starter/templates/managed/skills/kortix-ui/SKILL.md`
  (`kortix-ui` is in `KORTIX_MANAGED_SKILL_NAMES`, so the sandbox bake ships it).
  `src/skill.test.ts` fails when the copies differ or when the skill's
  Components table misses an export of `src/index.ts` or `src/chat/index.ts`.
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
| `strings` | English copy (`defaultUiStrings`; `chat` keys in `defaultChatStrings`) |
| `link` | a plain `<a>`: every link is a full page load |
| `image` | a plain `<img>` |
| `navigation` | `defaultUiNavigation`: `push` / `replace` are full page loads, `usePathname` / `useSearchParams` read `window.location`, `useParams` returns `{}` |
| `i18n` | the bundled English catalog of `@kortix/ui/i18n` |
| `useViewerId` | no signed-in user (`undefined`) |
| `useBrand` | the Kortix marks |
| `config` | `{ billingEnabled: false }` |

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
  strings={{ confirm: t('confirm'), chat: { send: t('send') } }}
  link={NextLink}
  image={NextImage}
  navigation={navigation}
  i18n={i18n}
  useViewerId={useViewerId}
  config={{ billingEnabled: true }}
>
  {app}
</UiProvider>
```

`image={NextImage}` needs `images.remotePatterns` for every remote logo URL.

The session UI reads the project and session it renders from
`SessionIdsProvider`, never from route params. Mount one around each session
view: `<SessionIdsProvider projectId={projectId} sessionId={sessionId}>`.
`useSessionIds()` reads it; without a provider both ids are `undefined`, and
components that need them render nothing.

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
(`@kortix/ui/lib/lazy-client`) loads a component on the client only, the
`next/dynamic(..., { ssr: false })` contract. `ErrorBoundary` and
`ErrorBoundaryFallback` (`@kortix/ui/error-boundary`) report to
`captureException`.

Dark mode is the `dark` class on `<html>` (`useIsDark()` reads it).

Import components by subpath: `import { Button } from '@kortix/ui/button'`.
The root `@kortix/ui` barrel holds only light core primitives. Toasts need one
`<Toaster />` from `@kortix/ui/toast` at the root; `IconProvider`
(`@kortix/ui/icon-provider`) sets the house icon weight.

## Chat

Every part of `@kortix/ui/chat` needs `@kortix/sdk` and `@tanstack/react-query`
5 (`@kortix/sdk/react` imports it; it is an optional peer, so npm does not
warn when it is missing and the bundler fails instead):
`npm i @kortix/ui @kortix/sdk @tanstack/react-query`, plus one
`QueryClientProvider`.

```tsx
import { useSession } from '@kortix/sdk/react';
import { SessionThread } from '@kortix/ui/chat';

<SessionThread session={useSession(projectId, sessionId)} />
```

`src/chat/index.ts` lists every part (`MessageList`, `MessageView`, `Composer`,
the prompts, the pickers) for a host that composes its own layout. A fully
custom transcript uses `renderParts` from `@kortix/sdk/react`.

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

- React 19: npm prints `ERESOLVE overriding peer dependency` for `cmdk@0.2.1`
  (React 18 peer) and nests `@radix-ui/react-dialog@1.0.0` under it. The install
  succeeds. A host with `strict-peer-dependencies` must allow it. `cmdk` 1.x
  changes the selection model `command.tsx` is tuned to, and `apps/web` imports
  `cmdk` directly, so the upgrade is its own change.

## Rules

- Values: the `kortix-brand` skill (`.agents/skills/kortix-brand/SKILL.md`).
  The generator is `.agents/skills/kortix-brand/scripts/generate-tokens.ts`.
- Components: the `kortix-design-system` skill.
- Imports inside the package are relative. Never import `apps/web` code.
- Edit a component here, never its `apps/web` shim. A shim is only
  `export * from '@kortix/ui/<name>'` (plus `'use client'` and the default
  re-export when the component has them).
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
