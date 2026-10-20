# Theme @kortix/ui for another brand

Every value a host varies is a CSS variable: colors in light and dark, radius, border width, fonts,
the type scale, density, shadows and motion. `@kortix/ui/theme` turns a typed object into those
variables. Never fork or restyle a component: a forked copy stops receiving fixes.

## 1. The whole app

```ts
// src/theme.ts
import type { KortixTheme } from '@kortix/ui/theme';

// The company brand. Every field is optional: an unset one keeps the Kortix value.
export const acmeTheme: KortixTheme = {
  light: { blue: '#0f766e', ring: '#0f766e', border: '#cbd5e1', muted: '#f1f5f9' },
  dark: { blue: '#2dd4bf', ring: '#2dd4bf', border: '#334155', muted: '#1e293b' },
  radius: '0.375rem',
  fonts: { sans: 'Georgia, "Times New Roman", serif' },
};
```

```tsx
import { themeToCss } from '@kortix/ui/theme';
import { acmeTheme } from './theme';

const themeCss = themeToCss(acmeTheme);

// React 19 hoists <style href precedence> into <head>. A server-rendered host
// writes themeToCss(theme) into its <head> instead: the first paint is on brand.
<style href="acme-theme" precedence="default">{themeCss}</style>
```

`themeToCss` is pure (runs on the server). Its rules out-rank `tokens.css`, so the `<style>` can sit
anywhere. A `dark` color falls back to the Kortix dark default, never to your `light` value.

## 2. One subtree

```tsx
import { ThemeScope, type KortixTheme } from '@kortix/ui/theme';
import type { ReactNode } from 'react';

const preview: KortixTheme = { light: { blue: '#7c3aed', ring: '#7c3aed' }, radius: '1rem' };

// One subtree in another brand; its dialogs and menus portal into the same theme.
export function Preview({ children }: { children: ReactNode }) {
  return <ThemeScope theme={preview} className="bg-background">{children}</ThemeScope>;
}
```

- `ThemeScope` sets `font-family` and `color` on its element and paints no background (add `bg-background`).
- `className="dark"` forces dark inside a light page. The reverse does not exist: `.dark` on `<html>` reaches the scope.
- Toasts do not portal: mount `<Toaster />` inside the scope to theme them.

## 3. The API

| Export | Signature | Use |
| --- | --- | --- |
| `KortixTheme` | `{ light?, dark?, radius?, spacing?, borderWidth?, fonts?, text?, lineHeights?, shadows?, durations?, easing?, vars? }` | The theme. An unknown key is a type error and throws at runtime. |
| `themeToCss` | `(theme, selector = ':root') => string` | Light outside `.dark`, dark on or inside `.dark`. Throws on `;`, `{`, `}`, `<`, `>`, `\` or a comment in a value, so tenant data cannot add rules. |
| `themeToCssVars` | `(theme) => { light, dark }` | The same variables as data, to set from JavaScript. |
| `ThemeScope` | `<ThemeScope theme className? {...divProps}>` | Themes one subtree, overlays included. |
| `THEME_COLOR_VARS` | `{ background: '--background', … }` (const) | Each color key and its CSS variable; `ThemeColor` is its key type. |

## 4. Keys

Colors (`light`, `dark`; any CSS color):

| Key | Variable | Controls |
| --- | --- | --- |
| `background`, `foreground` | `--background`, `--foreground` | The page, text, the default `Button` fill |
| `pane`, `surface` | `--pane`, `--surface` | Base and raised panes |
| `card`, `popover` (+ `…Foreground`) | `--card`, `--popover` | `Card`, tool cards, questions; menus, popovers, inputs |
| `primary` (+ `primaryForeground`) | `--primary` | `Progress`, `Slider`, menu highlight, selection |
| `secondary`, `muted`, `accent` (+ `…Foreground`) | `--secondary`, `--muted`, `--accent` | Secondary buttons; quiet fills, the user bubble, code blocks; hovered rows |
| `destructive` | `--destructive` | Errors, destructive buttons |
| `border`, `input` | `--border`, `--input` | Every hairline; input fills |
| `ring`, `focusRing` | `--ring`, `--focus-ring` | Focus rings, the focused composer |
| `blue` | `--kortix-blue` | The accent: checked `Switch` / `Checkbox`, `brand` `Button`, info tone |
| `green`, `orange`, `yellow`, `red`, `purple` | `--kortix-*` | Status tones. Keep their meaning. |
| `sidebar…` | `--sidebar-*` | The sidebar; `sidebar` also fills `Modal` and `Sheet` |
| `terminalSurface`, `terminalForeground`, `terminalBorder` | `--terminal-*` | The terminal pane |
| `chart1` … `chart5` | `--chart-*` | Chart series |

Shared values (both modes):

| Key | Variable | Controls |
| --- | --- | --- |
| `radius` | `--radius` | Every corner: `rounded` −6px, `-sm` −4px, `-md` −2px, `-lg` =, `-xl` +4px, `-2xl` +6px |
| `borderWidth` | `--border-width` | Every bare `border*` and `divide-*` |
| `spacing` | `--spacing` | Density: every `p-*`, `m-*`, `gap-*`, `size-*` (default `0.23rem`) |
| `fonts.sans`, `fonts.mono` | `--font-family-sans`, `--font-family-mono` | Body and headings; code, ids, `Badge` |
| `text.<step>`, `lineHeights.<step>` | `--text-<step>`, `--text-<step>--line-height` | The type scale, `xs` … `8xl` |
| `shadows.<step>` | `--shadow-<step>` | Elevation; `0 0 #0000` flattens a step |
| `durations.<step>`, `easing.<curve>` | `--duration-*`, `--ease-*` | Motion: `fast` … `slower`; `default`, `in`, `out`, `inOut` |
| `vars` | any `--name` | Anything else |

Defaults and the fixed values (scrims, 10–12px captions, a few keyframe durations): https://kortix.com/docs/sdk/ui#tokens.

## 5. Rules

1. Your marks go through `UiProvider useBrand` (`{ app_name, logo_url, icon_url, logo_dark_url, icon_dark_url }`): the UI draws them in place of Kortix's.
2. Never load `@kortix/ui/fonts.css` (Roobert is Kortix-only). Set `fonts.sans`.
3. Plain CSS works too, after the `@kortix/ui` import: light values in `:root:not(.dark)`, dark values in `.dark`.
   A bare `:root` rule also matches `<html class="dark">`.
4. Verify in the browser: `getComputedStyle(document.documentElement).getPropertyValue('--radius')` shows your value,
   a checked `Switch` wears `blue`, the thread renders in `fonts.sans`, in light and dark.
