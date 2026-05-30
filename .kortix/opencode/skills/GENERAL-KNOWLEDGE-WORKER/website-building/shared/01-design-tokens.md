# Design Tokens — Type, Spacing, Color, Base CSS

Every website must include these design systems and base stylesheet before any component styles.

---

## Type Scale

Use a fluid type scale with `clamp()`. Every text element references a scale token — never hardcode font sizes.

**Minimum size floor: 12px (0.75rem).** No text on screen should ever render below 12px. This is the absolute floor for tiny labels and metadata.

```css
:root {
  --text-xs:   clamp(0.75rem,  0.7rem  + 0.25vw, 0.875rem);  /* 12px floor → 14px */
  --text-sm:   clamp(0.875rem, 0.8rem  + 0.35vw, 1rem);      /* 14px floor → 16px */
  --text-base: clamp(1rem,     0.95rem + 0.25vw, 1.125rem);   /* 16px floor → 18px */
  --text-lg:   clamp(1.125rem, 1rem    + 0.75vw, 1.5rem);     /* 18px → 24px */
  --text-xl:   clamp(1.5rem,   1.2rem  + 1.25vw, 2.25rem);    /* 24px → 36px */
  --text-2xl:  clamp(2rem,     1.2rem  + 2.5vw,  3.5rem);     /* 32px → 56px */
  --text-3xl:  clamp(2.5rem,   1rem    + 4vw,    5rem);        /* 40px → 80px */
  --text-hero: clamp(3rem,     0.5rem  + 7vw,    8rem);        /* 48px → 128px */
}
```

### Preferred Sizes for UI Elements

| Element | Token | Resolves to | Notes |
|---|---|---|---|
| **Tiny labels, badges, metadata** | `--text-xs` | 12-14px | The absolute floor (12px min). Only for secondary/tertiary info. |
| **Buttons, nav links** | `--text-sm` | 14-16px | Standard for all interactive UI text. |
| **Body text (all contexts)** | `--text-base` | 16-18px | **The default for body copy.** 16px is the baseline for comfortable reading in product UI, editorial, and all other contexts. |
| **Body text (editorial/long-form)** | `--text-base` to `--text-lg` | 16-24px | Long-form reading benefits from 18px. |
| **Section headings** | `--text-lg` | 18-24px | One step up from body. Body font bold or display font. |
| **Page title** | `--text-xl` | 24-36px | ONE per page. This is where display fonts start. |
| **Hero heading (informational/landing ONLY)** | `--text-2xl` | 32-56px | Display font. ONE per page. **Not for web apps** — web app page titles cap at `--text-xl`. |
| **Display (informational/landing ONLY)** | `--text-3xl`/`--text-hero` | 40-128px | Informational sites only — editorial heroes, portfolio splash, landing headlines. Never in web apps, dashboards, or interior pages. |

### Max Display Size by Site Type

| Site type | Max token | Max resolves to | Notes |
|---|---|---|---|
| **Informational** (portfolio, editorial, landing) | `--text-hero` | 128px | Dramatic display headlines in the hero section. Interior pages cap at `--text-2xl`. |
| **Web app** (SaaS, dashboard, admin, e-commerce) | `--text-xl` | 36px | Web apps are functional, not theatrical. Page titles use `--text-xl`. No display-scale type. |
| **Brand experience** | `--text-2xl` | 56px | ONE hero moment allowed. Everything else at `--text-xl` or below. |

Fluid type rules:
- **Pick 3-4 sizes per page max.** Typical page: `--text-xs` (tiny labels), `--text-sm` (buttons/nav), `--text-base` (body), `--text-lg` (headings). Informational/landing pages add `--text-2xl` for hero.
- **Web apps cap at `--text-xl`.** SaaS products, dashboards, admin panels, and e-commerce UIs should never use `--text-2xl` or above. Page titles use `--text-xl` (24-36px). If it feels small, increase font-weight or spacing — not size.
- **Body copy is `--text-base` (16px), not `--text-lg`.** The most common sizing mistake is using `--text-lg` for body text, which makes everything feel bloated. `--text-lg` is for section headings.
- Use `rem` for min/max bounds; mix `vw` with `rem` in preferred value (`1rem + 2vw`) so zooming works.
- Test at 200% zoom (WCAG requirement).

---

## 4px Spacing System

All spacing derives from a 4px base unit.

```css
:root {
  --space-1:  0.25rem;  /*  4px */
  --space-2:  0.5rem;   /*  8px */
  --space-3:  0.75rem;  /* 12px */
  --space-4:  1rem;     /* 16px */
  --space-5:  1.25rem;  /* 20px */
  --space-6:  1.5rem;   /* 24px */
  --space-8:  2rem;     /* 32px */
  --space-10: 2.5rem;   /* 40px */
  --space-12: 3rem;     /* 48px */
  --space-16: 4rem;     /* 64px */
  --space-20: 5rem;     /* 80px */
  --space-24: 6rem;     /* 96px */
  --space-32: 8rem;     /* 128px */
}
```

Rules:
- **Every** margin, padding, gap must reference a spacing token. Never arbitrary pixel values.
- `--space-1`-`3` for tight spacing (icon gaps, input/badge padding); `--space-4`-`8` for component spacing (card padding, form gaps); `--space-10`-`32` for layout spacing (section padding, page gutters).
- Fluid section spacing: `padding-block: clamp(var(--space-8), 6vw, var(--space-24));`

---

## Color Hierarchy

Use OKLCH as your primary color space. Define a layered system with semantic roles — never hardcode hex values.

**Color restraint philosophy:** See `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for the full rationale. In brief: 1 accent + neutrals for most pages. Remaining palette colors (orange, gold, blue, purple, notification) are reserved for data visualization only.

### Light & Dark Mode (Mandatory)

**Every website must include both light AND dark mode.** Use `prefers-color-scheme` as default, with a manual toggle (sun/moon icon) in the header. The toggle should:
- Set `data-theme="light"` or `data-theme="dark"` on `<html>` to override system preference
- CSS pattern: `:root, [data-theme="light"]` for light; `[data-theme="dark"]` for dark
- Store preference in a JS variable (not localStorage — sandboxed iframes block it)
- Default to system preference via `window.matchMedia('(prefers-color-scheme: dark)')`

### Art Direction First — EVERY Site Gets a Unique Palette

**EVERY website must have a UNIQUE color palette.** Do NOT reuse the same colors across different sites.

**Step 1: Generate a palette.** Run the palette generator script with keywords describing the subject:

```bash
bun run skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/generate-palette.ts "coffee shop warm cozy"
```

This outputs 5 harmonious palettes (analogous, complementary, triadic, split-complementary, monochromatic) with ready-to-use CSS variables for both light and dark modes. Pick the one that fits best, then customize.

**Step 2: Pick and customize.** Choose the harmony that fits the subject's mood:
- **Analogous** — harmonious, calm (spas, nature, editorial)
- **Complementary** — bold contrast, energy (startups, sports, food)
- **Triadic** — vibrant, balanced (creative agencies, kids, events)
- **Split-complementary** — contrast with subtlety (portfolios, shops)
- **Monochromatic** — elegant, focused (luxury, minimalist, academic)

**Step 3: If the user provides brand colors,** skip the generator and build the palette around their colors. Maintain the same CSS variable structure.

**NEVER build two sites that look the same.** Different subject = different palette, different fonts, different vibe.

Maintain both light and dark modes. Ensure WCAG AA contrast (4.5:1 body text, 3:1 large text).

### Kortix Design System (Fallback Palette — ONLY for Kortix-branded sites)

This palette is ONLY for sites that are explicitly Kortix-branded. For everything else, run the palette generator.

```css
/* NEXUS DESIGN SYSTEM — warm beige surfaces, teal primary accent */

:root, [data-theme="light"] {
  /* Surfaces (Kortix Beige) */
  --color-bg:             #f7f6f2;
  --color-surface:        #f9f8f5;
  --color-surface-2:      #fbfbf9;
  --color-surface-offset: #f3f0ec;
  --color-surface-offset-2: #edeae5;
  --color-surface-dynamic: #e6e4df;
  --color-divider:        #dcd9d5;
  --color-border:         #d4d1ca;

  /* Text (Sylph Gray) */
  --color-text:           #28251d;
  --color-text-muted:     #7a7974;
  --color-text-faint:     #bab9b4;
  --color-text-inverse:   #f9f8f4;

  /* Primary Accent (Hydra Teal) */
  --color-primary:        #01696f;
  --color-primary-hover:  #0c4e54;
  --color-primary-active: #0f3638;
  --color-primary-highlight: #cedcd8;

  /* Warning (Terra Brown) */
  --color-warning:        #964219;
  --color-warning-hover:  #713417;
  --color-warning-active: #4b2614;
  --color-warning-highlight: #ddcfc6;

  /* Error (Jenova Maroon) */
  --color-error:          #a12c7b;
  --color-error-hover:    #7d1e5e;
  --color-error-active:   #561740;
  --color-error-highlight: #e0ced7;

  /* Notification (Rosa Red) */
  --color-notification:   #a13544;
  --color-notification-hover: #782b33;
  --color-notification-active: #521f24;
  --color-notification-highlight: #dececb;

  /* Orange (Costa) */
  --color-orange:         #da7101;
  --color-orange-hover:   #c55700;
  --color-orange-active:  #ac3e00;
  --color-orange-highlight: #e7d7c4;

  /* Gold (Altana) */
  --color-gold:           #d19900;
  --color-gold-hover:     #b07a00;
  --color-gold-active:    #8a5b00;
  --color-gold-highlight: #e9e0c6;

  /* Yellow (Dalmasca) — shares base with Gold; diverges in dark mode */
  --color-yellow:         #d19900;
  --color-yellow-hover:   #b07a00;
  --color-yellow-active:  #8a5b00;
  --color-yellow-highlight: #e6ddc4;

  /* Success (Gridania Green) */
  --color-success:        #437a22;
  --color-success-hover:  #2e5c10;
  --color-success-active: #1e3f0a;
  --color-success-highlight: #d4dfcc;

  /* Blue (Limsa) */
  --color-blue:           #006494;
  --color-blue-hover:     #0b5177;
  --color-blue-active:    #0b3751;
  --color-blue-highlight: #c6d8e4;

  /* Purple (Kuja) */
  --color-purple:         #7a39bb;
  --color-purple-hover:   #5f2699;
  --color-purple-active:  #431673;
  --color-purple-highlight: #dacfde;

  /* Radius */
  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  --radius-full: 9999px;

  /* Transitions */
  --transition-interactive: 180ms cubic-bezier(0.16, 1, 0.3, 1);

  /* Shadows (tone-matched to warm surfaces) */
  --shadow-sm: 0 1px 2px oklch(0.2 0.01 80 / 0.06);
  --shadow-md: 0 4px 12px oklch(0.2 0.01 80 / 0.08);
  --shadow-lg: 0 12px 32px oklch(0.2 0.01 80 / 0.12);

  /* Content widths */
  --content-narrow: 640px;
  --content-default: 960px;
  --content-wide: 1200px;
  --content-full: 100%;

  /* Font families — MUST define --font-body and --font-display in your style.css.
     Always load a distinctive font via CDN — system fonts are fallback only.
     Example: --font-display: 'Instrument Serif', Georgia, serif;
              --font-body: 'Work Sans', 'Helvetica Neue', sans-serif;
     The first name is the loaded font; system fonts after it are the safety net.
     base.css uses var(--font-body, sans-serif) as fallback. */
}

/* DARK MODE */
[data-theme="dark"] {
  --color-bg:             #171614;
  --color-surface:        #1c1b19;
  --color-surface-2:      #201f1d;
  --color-surface-offset: #1d1c1a;
  --color-surface-offset-2: #22211f;
  --color-surface-dynamic: #2d2c2a;
  --color-divider:        #262523;
  --color-border:         #393836;
  --color-text:           #cdccca;
  --color-text-muted:     #797876;
  --color-text-faint:     #5a5957;
  --color-text-inverse:   #2b2a28;
  --color-primary:        #4f98a3;
  --color-primary-hover:  #227f8b;
  --color-primary-active: #1a626b;
  --color-primary-highlight: #313b3b;
  --color-warning:        #bb653b;
  --color-warning-hover:  #b95525;
  --color-warning-active: #993d10;
  --color-warning-highlight: #564942;
  --color-error:          #d163a7;
  --color-error-hover:    #b9478f;
  --color-error-active:   #9b2f76;
  --color-error-highlight: #4c3d46;
  --color-notification:   #dd6974;
  --color-notification-hover: #c24a59;
  --color-notification-active: #a53142;
  --color-notification-highlight: #574848;
  --color-orange:         #fdab43;
  --color-orange-hover:   #fec47e;
  --color-orange-active:  #fdd1a4;
  --color-orange-highlight: #564b3e;
  --color-gold:           #e8af34;
  --color-gold-hover:     #fdc551;
  --color-gold-active:    #feda74;
  --color-gold-highlight: #4d4332;
  --color-yellow:         #edb336;
  --color-yellow-hover:   #fdc452;
  --color-yellow-active:  #feda74;
  --color-yellow-highlight: #574e3d;
  --color-success:        #6daa45;
  --color-success-hover:  #4d8f25;
  --color-success-active: #387015;
  --color-success-highlight: #3a4435;
  --color-blue:           #5591c7;
  --color-blue-hover:     #3b78ab;
  --color-blue-active:    #275f8e;
  --color-blue-highlight: #3a4550;
  --color-purple:         #a86fdf;
  --color-purple-hover:   #9250d0;
  --color-purple-active:  #7537ba;
  --color-purple-highlight: #4e4652;
  --shadow-sm: 0 1px 2px oklch(0 0 0 / 0.2);
  --shadow-md: 0 4px 12px oklch(0 0 0 / 0.3);
  --shadow-lg: 0 12px 32px oklch(0 0 0 / 0.4);
}

/* System preference fallback: duplicate [data-theme="dark"] variables
   inside @media (prefers-color-scheme: dark) { :root:not([data-theme]) { ... } }
   to support users who haven't toggled manually. */
```

**Dark mode toggle (include in every project):**
```javascript
(function(){const t=document.querySelector('[data-theme-toggle]'),r=document.documentElement;let d=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';r.setAttribute('data-theme',d);t&&t.addEventListener('click',()=>{d=d==='dark'?'light':'dark';r.setAttribute('data-theme',d);t.setAttribute('aria-label','Switch to '+(d==='dark'?'light':'dark')+' mode');t.innerHTML=d==='dark'?'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>':'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'})})();
```

---

## Color Implementation Notes

- **Three text levels**: primary, muted, faint. **Surface layers**: bg → surface → surface-2 → surface-offset.
- `color-mix(in oklab, ...)` for opacity adjustments. Custom palettes: replace Kortix defaults but keep variable names + both modes.
- **Better gradients**: `linear-gradient(in oklab, var(--color-primary), var(--color-blue))`. **P3 wide-gamut**: `@media (color-gamut: p3) { :root { --color-primary: oklch(0.48 0.14 192); } }`

### Kortix HSL Equivalents (for Tailwind / shadcn projects)

When using the fullstack webapp template (Tailwind + shadcn), `index.css` uses HSL values in `H S% L%` format (no `hsl()` wrapper). Below are Kortix HSL conversions for when Kortix is the appropriate fallback (see "Art Direction First" above). For inferred or custom palettes, convert your chosen colors to the same `H S% L%` format:

**Light mode:**

| Role | Hex | HSL (`H S% L%`) |
|---|---|---|
| Background | `#F7F6F2` | `45 24% 96%` |
| Surface / Card | `#F9F8F5` | `45 25% 97%` |
| Surface-2 | `#FBFBF9` | `45 20% 98%` |
| Surface-offset | `#F3F0EC` | `36 18% 94%` |
| Border | `#D4D1CA` | `36 8% 81%` |
| Divider | `#DCD9D5` | `34 8% 85%` |
| Text | `#28251D` | `44 23% 14%` |
| Text muted | `#7A7974` | `50 3% 47%` |
| Text faint | `#BAB9B4` | `50 3% 72%` |
| Primary (Teal) | `#01696F` | `183 98% 22%` |
| Primary hover | `#0C4E54` | `185 75% 19%` |
| Error (Maroon) | `#A12C7B` | `320 57% 40%` |
| Warning (Brown) | `#964219` | `20 73% 34%` |
| Success (Green) | `#437A22` | `103 56% 31%` |

**Dark mode:**

| Role | Hex | HSL (`H S% L%`) |
|---|---|---|
| Background | `#171614` | `40 10% 8%` |
| Surface / Card | `#1C1B19` | `40 9% 10%` |
| Surface-2 | `#201F1D` | `40 8% 12%` |
| Border | `#393836` | `40 3% 22%` |
| Text | `#CDCCCA` | `40 3% 80%` |
| Text muted | `#797876` | `40 2% 47%` |
| Primary (Teal) | `#4F98A3` | `188 35% 47%` |
| Error | `#D163A7` | `320 47% 60%` |
| Warning | `#BB653B` | `20 53% 48%` |
| Success | `#6DAA45` | `97 43% 47%` |

These are the Kortix fallback values. **Always try to derive a concept-driven palette first** (see "Art Direction First" above). Use Kortix only when the request is truly generic with no topic to infer from. When deriving a custom palette, convert your chosen colors to the same `H S% L%` format and role structure with both light and dark modes.

---

## Base Stylesheet

**Every project must include this base CSS** before any component styles.

```css
/* base.css */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html {
  -moz-text-size-adjust: none;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  scroll-behavior: smooth;
  hanging-punctuation: first last;
  scroll-padding-top: var(--space-16);
}

body {
  min-height: 100dvh;
  line-height: 1.6;
  font-family: var(--font-body, sans-serif);
  font-size: var(--text-base);
  color: var(--color-text);
  background-color: var(--color-bg);
}

img, picture, video, canvas, svg { display: block; max-width: 100%; height: auto; }
ul[role="list"], ol[role="list"] { list-style: none; }
input, button, textarea, select { font: inherit; color: inherit; }

h1, h2, h3, h4, h5, h6 { text-wrap: balance; line-height: 1.15; }
p, li, figcaption { text-wrap: pretty; max-width: 72ch; }

::selection {
  background: oklch(from var(--color-primary) l c h / 0.25);
  color: var(--color-text);
}

:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 3px;
  border-radius: var(--radius-sm);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

button { cursor: pointer; background: none; border: none; }
table { border-collapse: collapse; width: 100%; }

/* Interactive elements: animate hover/focus transitions.
   Only clickable elements get hover states — see `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/03-motion.md`.
   Never add :hover styles to non-interactive elements. */
a, button, [role="button"], [role="link"], input, textarea, select {
  transition: color var(--transition-interactive),
              background var(--transition-interactive),
              border-color var(--transition-interactive),
              box-shadow var(--transition-interactive);
}

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0;
}
```