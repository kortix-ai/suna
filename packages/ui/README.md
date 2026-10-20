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

Mount the adapters once at the root:

```tsx
import { UiProvider } from '@kortix/ui';
<UiProvider strings={{ confirm: t('confirm'), chat: { send: t('send') } }} link={NextLink}>{app}</UiProvider>
```

`strings` takes any subset of `UiStrings`: `confirm`, `cancel`, `close`,
`commandPaletteTitle`, `commandPaletteDescription`, and `chat` (every string
of `@kortix/ui/chat`; `defaultChatStrings` lists the keys). Without
`UiProvider`, components render English copy and a plain `<a>`.
`MermaidRenderer`'s controls are English only.
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

## White-label

Override the CSS variables from `tokens.css` in your own `:root` / `.dark`.
Never fork a component. Roobert (`--font-roobert`) is Kortix-owned surfaces
only; every other host renders the system stack (`--font-sans-system`).

| Variable | What follows it |
| --- | --- |
| `--kortix-blue` | The accent: checked `Switch` / `Checkbox` / `RadioGroup`, `brand` and `blue` `Button` variants, info `Badge`, `InfoBanner`, `Alert`, status, toast |
| `--ring` | Focus rings; `--kortix-base`, `--sidebar-ring` and `--sidebar-primary` (sidebar selection) follow it |
| `--sidebar-primary-foreground` | Text on the sidebar selection |
| `--foreground`, `--background` | Text, the page, the default `Button` (`bg-foreground text-background`) |
| `--primary`, `--primary-foreground` | `Progress`, `Slider`, `Calendar` selection, menu row tint, default selection |
| `--kortix-green`, `--kortix-orange`, `--destructive` | Success, warning, error tones |
| `--radius`, `--font-sans-system` | Radius, font stack |

`apps/whitelabel-demo/src/app/globals.css` is the reference: it sets
`--kortix-blue` and `--ring` to its brand.

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
