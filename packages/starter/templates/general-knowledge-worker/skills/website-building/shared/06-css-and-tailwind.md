# CSS & Tailwind

Modern CSS features, Tailwind CSS v3, shadcn/ui component system, and cutting-edge CSS.

---

## Tailwind CSS v3

All projects use **Tailwind CSS v3** with a `tailwind.config.ts` and PostCSS. Do NOT use Tailwind v4 syntax (`@import "tailwindcss"`, `@theme`) — it is incompatible with the webapp template and will crash the dev server. Stick to v3 patterns throughout.

### CSS Directives

Use the `@tailwind` directives — **not** `@import "tailwindcss"`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### Configuration via `tailwind.config.ts`

Tailwind uses a config file for customization. The template's config extends colors via CSS custom properties with the HSL `<alpha-value>` pattern:

```ts
// tailwind.config.ts (already in template — extend, don't replace)
import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./client/index.html", "./client/src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        // ... full color map in template
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
} satisfies Config;
```

### HSL Color Variable Format

When defining custom properties in `index.css`, use **space-separated H S% L%** (no `hsl()` wrapper):

```css
:root {
  --background: 45 24% 96%;
  --foreground: 44 23% 14%;
  --primary: 183 98% 22%;
  --primary-foreground: 0 0% 98%;
}

.dark {
  --background: 40 10% 8%;
  --foreground: 40 3% 80%;
  --primary: 188 35% 47%;
  --primary-foreground: 0 0% 98%;
}
```

The `hsl(var(--primary) / <alpha-value>)` pattern in the config wraps these values at build time, enabling Tailwind's opacity modifier syntax (`bg-primary/50`).

### Dark Mode

Dark mode uses the `.dark` class strategy:

1. Set `darkMode: ["class"]` in `tailwind.config.ts`
2. Define `:root` (light) and `.dark` (dark) variable sets in `index.css`
3. Toggle the `dark` class on `document.documentElement`
4. Use `dark:` prefix for one-off overrides: `className="bg-white dark:bg-black"`

### Key Features

- `@apply` in CSS for reusable utility compositions
- Group/peer modifiers: `group-hover:opacity-100`, `peer-checked:translate-x-full`
- Arbitrary values: `text-[clamp(1rem,3vw,2rem)]`, `grid-cols-[200px_1fr]`
- Arbitrary variants: `[&:nth-child(odd)]:bg-surface`
- `motion-safe:` and `motion-reduce:` for respecting `prefers-reduced-motion`
- Ring utilities for focus indication: `focus:ring-2 focus:ring-primary`

### Elevation System (Webapp Template)

The template includes a custom elevation system for interactive states. Instead of traditional shadows, it uses overlay-based brightness adjustment:

```html
<!-- Hover brightness -->
<div class="hover-elevate">Brightens on hover</div>

<!-- Active press state -->
<button class="active-elevate-2">Darkens on press</button>

<!-- Toggle state (e.g., selected tab) -->
<div class="toggle-elevate toggle-elevated">Currently active</div>
```

This system works in both light and dark mode via `--elevate-1` / `--elevate-2` CSS variables (light mode uses `rgba(0,0,0,…)`, dark mode uses `rgba(255,255,255,…)`).

**When using Tailwind, handle container queries, arbitrary properties, stateful variants, and responsive design entirely in markup.** Minimize context-switches between HTML and CSS files.

---

## shadcn/ui — The Component System

shadcn/ui is the standard component system for React projects. It is not a dependency you install — it copies source code into your project, giving you full ownership and zero version lock-in. Components are built on Radix UI primitives (accessible, keyboard-navigable, WAI-ARIA compliant) and styled with Tailwind CSS.

**When to use shadcn/ui:**
- The project uses React (Next.js, Remix, Vite, Astro with React)
- You need interactive components: dialogs, dropdowns, tabs, popovers, command palettes, data tables, accordions, tooltips, sheets, toasts
- You want accessibility handled correctly out of the box — focus management, keyboard nav, screen reader support
- You'd rather customize source code than fight a library's theming API

**When NOT to use it:**
- Vanilla HTML/CSS/JS projects — shadcn/ui is React-only. For non-React projects, build components from scratch using the base CSS, Tailwind, and the Popover/Dialog APIs from native HTML
- Simple landing pages with no interactive UI beyond links and scroll — the overhead isn't worth it

**Most projects are vanilla HTML** (static to S3, no build step). Only use shadcn when the user requests React or the project needs complex interactive components (data tables, command palettes, drawers). Landing pages, portfolios, editorial → build by hand.

### Setup — Webapp Template (Pre-installed)

The webapp template ships with shadcn pre-installed (52 components in `client/src/components/ui/`). No setup needed — just import and use:

```tsx
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
```

To add additional components not in the template:
```bash
npx shadcn@latest add command tooltip accordion
```

### Setup — From Scratch

For non-template React projects:
```bash
npm create vite@latest myapp -- --template react-ts
cd myapp && npm install
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
npx shadcn@latest init
# Choose: New York style (smaller, shadow-based — matches this skill's aesthetic)
```

Then add components as needed:
```bash
npx shadcn@latest add button dialog dropdown-menu tabs tooltip
```

### Theming — Bridge shadcn/ui to Design Tokens

shadcn/ui uses its own CSS variable naming convention. Map your palette to shadcn's expected variables in `index.css` using **space-separated HSL** (no `hsl()` wrapper) so both systems work together:

```css
:root {
  /* Kortix light → shadcn variables (H S% L% format) */
  --background: 45 24% 96%;       /* --color-bg #F7F6F2 */
  --foreground: 44 23% 14%;       /* --color-text #28251D */
  --card: 45 25% 97%;             /* --color-surface #F9F8F5 */
  --card-foreground: 44 23% 14%;
  --primary: 183 98% 22%;         /* --color-primary #01696F */
  --primary-foreground: 0 0% 98%;
  --muted-foreground: 50 3% 47%;  /* --color-text-muted #7A7974 */
  --destructive: 320 57% 40%;     /* --color-error #A12C7B */
  --border: 36 8% 81%;            /* --color-border #D4D1CA */
  --ring: 183 98% 22%;
}
```

This way, every shadcn/ui component automatically inherits the skill's color system, including dark mode.

### Key Components and When to Reach for Them

| Component | When to use |
|---|---|
| `Button` | All clickable actions. Use the variant system (default, secondary, outline, ghost, destructive) |
| `Dialog` / `Sheet` | Modal content. Dialog for centered, Sheet for slide-from-edge |
| `DropdownMenu` | Context menus, action menus on cards/rows |
| `Command` | Command palette (⌘K). Pairs with `Dialog` for a spotlight search |
| `Tabs` | Switching between views in a contained area |
| `Tooltip` | Hover hints for icon-only buttons and truncated text |
| `Table` + `DataTable` | Data-heavy layouts. Built on TanStack Table for sort/filter/pagination |
| `Form` | Any multi-field form. Built on React Hook Form + Zod validation |
| `Popover` | Floating content anchored to a trigger — filters, pickers, mini-panels |
| `Toast` / `Sonner` | Non-blocking feedback. Use for background confirmations, not critical errors |
| `Accordion` | Progressive disclosure. FAQ sections, settings panels |
| `Card` | Content containers with consistent padding, border, and radius |

**Principles:**
- **Add only what you use.** Each `add` command copies one component. Don't bulk-install everything — keep the project lean.
- **Customize after copying.** The whole point is that you own the code. Adjust the Tailwind classes, swap out Radix primitives, add motion — it's your file.
- **Compose upward.** Build semantic components from shadcn primitives: a `<UserCard>` that composes `Card` + `Avatar` + `Badge`, a `<ConfirmDialog>` that wraps `Dialog` with standard confirm/cancel actions.
- **Use the 180ms golden curve on all interactive states** within shadcn components — override any default transitions to use `var(--transition-interactive)`.

---

## Modern CSS Features (Well-Supported, Use Freely)

**90%+ support (use freely):** CSS Nesting, `oklch()`/`oklab()`, container queries, `@layer`, `@property`, `clamp()`, `color-mix()`, `:has()`, Popover API, `subgrid`, `content-visibility`, `text-wrap: balance`.

**80-90% (use with fallbacks):** Scroll-driven animations, view transitions, `@starting-style`, Anchor Positioning, `text-wrap: pretty`.

---

## Cutting-Edge CSS (Interop 2026)

Use with `@supports` fallbacks:

**`contrast-color()`** — auto-accessible text: `color: contrast-color(var(--color-primary))`. Safari first, cross-browser via Interop 2026.

**Advanced `attr()` typing** (Chrome 133+) — data attributes as CSS values:
```css
.chip { background-color: attr(data-color type(<color>)); }
.bar  { width: calc(attr(data-value type(<number>)) * 1%); }
```

**`shape()`** — responsive clip-paths with %, vw, calc (unlike pixel-only `path()`).

**`sibling-index()`** — CSS-only staggered animations: `animation-delay: calc(sibling-index() * 60ms)`.