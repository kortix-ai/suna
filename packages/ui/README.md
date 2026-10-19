# @kortix/ui

The shared React component library for `apps/web`, Kortix Apps and SDK hosts.
Components are Tailwind v4 class strings themed by CSS variables. Status: in
migration from `apps/web/src/components/ui`; `apps/web` keeps a one-line shim
at every old path.

## Use it

Tailwind host (apps/web, a Vite App with Tailwind):

```css
@import 'tailwindcss';
@import 'tw-animate-css';
@import '@kortix/ui/tokens.css'; /* or your own :root / .dark values */
@import '@kortix/ui/theme.css';  /* dark variant, @theme keys, utilities, keyframes; @source over the package */
```

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
<UiProvider strings={{ confirm: t('confirm') }} link={NextLink}>{app}</UiProvider>
```

Without `UiProvider`, components render English copy and a plain `<a>`.
Dark mode is the `dark` class on `<html>` (`useIsDark()` reads it).

Import components by subpath: `import { Button } from '@kortix/ui/button'`.
The root `@kortix/ui` barrel holds only light core primitives.

## White-label

Override the CSS variables from `tokens.css` in your own `:root` / `.dark`.
Never fork a component. Roobert (`--font-roobert`) is Kortix-owned surfaces
only; every other host renders the system stack (`--font-sans-system`).

## Rules

- Values: the `kortix-brand` skill (`.agents/skills/kortix-brand/SKILL.md`).
  The generator is `.agents/skills/kortix-brand/scripts/generate-tokens.ts`.
- Components: the `kortix-design-system` skill.
- Imports inside the package are relative. Never import `apps/web` code.
- `package.json` `exports` is generated: `pnpm --filter @kortix/ui gen-exports`.
  `src/exports.test.ts` fails on drift and on an export target that does not exist.
- `src/styles/tokens.css`, `src/styles/fonts.css` and the `theme` region of
  `src/styles/theme.css` are generated. `dist/styles.css` is built. Never edit them by hand.

## Checks

```sh
pnpm --filter @kortix/ui typecheck
pnpm --filter @kortix/ui test src/exports.test.ts   # exports map, targets, dist/styles.css drift
bun .agents/skills/kortix-brand/scripts/generate-tokens.ts --check
.agents/skills/kortix-brand/scripts/audit.sh packages/ui/src
```
