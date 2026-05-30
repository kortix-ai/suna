# Layout & Composition

Spatial composition, borders, radius, shadows, mobile-first design, and backgrounds.

---

## Spatial Composition

**Modern CSS layout techniques:**
- **CSS Grid + Subgrid** for complex 2D layouts with alignment inheritance
- **Container Queries** for component-level responsive design:
  ```css
  .card-container { container-type: inline-size; }
  @container (min-width: 400px) {
    .card { grid-template-columns: 200px 1fr; }
  }
  ```
- **CSS Nesting** (native, no preprocessor needed):
  ```css
  .card {
    padding: var(--space-4);
    background: var(--color-surface);

    & .title { font-size: var(--text-lg); }
    &:hover { box-shadow: var(--shadow-lg); }
    @media (width >= 768px) { padding: var(--space-8); }
  }
  ```

**Layout philosophy:**

The foundation is clean, grid-aligned composition. Within that orderly structure, introduce **one or two moments of visual surprise** — an overlapping element, an asymmetric hero, a grid-breaking accent. These moments work precisely because the rest of the page is disciplined.

- Most sections: clean grid, generous whitespace, aligned to the 4px spacing system
- 1-2 intentional moments per page: asymmetry, overlap, diagonal flow, or a grid-breaking element
- Bento grids for dashboards and portfolios — modular blocks of varying sizes
- Editorial/magazine grids for informational sites — vary column counts section-to-section (single-column prose → two-column features → full-bleed images → three-column cards) to create reading rhythm. See `informational/informational.md` for details.
- Use `clamp()` for fluid spacing: `padding: clamp(var(--space-4), 3vw, var(--space-12));`

**The rule**: if every section breaks the grid, none of them are surprising. Contrast requires a baseline of order.

### Content Width & Grid Guidance

- **Prose (articles, documentation, long-form text): max-width 65-75ch.** Use `max-width: 65ch;` on the paragraph container, centered with `margin-inline: auto`.
- **Headings and hero text can go wider** — up to the full content area — because display text is read differently than body text.
- **Data-dense layouts (dashboards, tables, admin panels): full width.** Use the full viewport minus sidebar.
- **Card grids: match card width to content density.** Let the content determine the `min()` in `grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));`
- **Masonry layouts: use for content of genuinely variable height.** CSS `masonry-layout` is experimental; use CSS columns or JS Masonry as a fallback:
  ```css
  /* CSS columns masonry (well-supported) */
  .masonry {
    columns: 3 300px;
    column-gap: var(--space-4);
  }
  .masonry > * {
    break-inside: avoid;
    margin-bottom: var(--space-4);
  }
  ```
- **Full-bleed moments: intentional, not default.** Use `max-width` containers for most content, break out to full-width for 1-2 dramatic moments.
- **The max-width ladder** (defined in `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md` as CSS variables):
  - `var(--content-narrow)` (640px) — focused prose, forms, single-column content
  - `var(--content-default)` (960px) — most page content, card grids
  - `var(--content-wide)` (1200px) — dashboards, multi-column layouts
  - `var(--content-full)` (100%) — full-bleed hero, edge-to-edge media
  ```css
  .container { max-width: var(--content-default); margin-inline: auto; padding-inline: var(--space-4); }
  ```

---

## Borders, Radius & Shadows

Borders, border-radius, and shadows are detail work — the difference between "this looks designed" and "this looks like a prototype." Be intentional with every pixel.

### Borders
- **Use alpha-blended borders, not solid gray.** A border that's a semi-transparent version of the text color adapts naturally to both light and dark mode:
  ```css
  border: 1px solid oklch(from var(--color-text) l c h / 0.12);
  ```
  In Tailwind: `border border-current/10` or `border border-black/10 dark:border-white/10`
- **1px is almost always correct.** 2px borders are for focus rings, active states, or intentional emphasis.
- **Border color should be quieter than the content it contains.** Borders are structure, not decoration.
- **Prefer surface shifts over borders.** Often a subtle background change (`--color-surface` → `--color-surface-2`) or a shadow creates cleaner separation than a border.

### Border Radius
- **Use the radius tokens** (`--radius-sm` through `--radius-full`). Never hardcode arbitrary radius values.
- **Match radius to element size.** Small elements (badges, chips) get `--radius-full` (pill shape). Medium elements (cards, inputs) get `--radius-md` to `--radius-lg`. Large containers get `--radius-lg` to `--radius-xl` or none at all.
- **Nested radius must account for padding.** When an inner element is rounded inside an outer rounded container, the inner radius must be smaller by the padding amount:
  ```css
  /* WRONG — same radius creates a lump */
  .card       { border-radius: 16px; padding: 12px; }
  .card-inner { border-radius: 16px; }  /* Curves don't align */

  /* RIGHT — inner radius = outer radius - padding */
  .card       { border-radius: var(--radius-xl); padding: var(--space-3); }  /* 16px, 12px */
  .card-inner { border-radius: calc(var(--radius-xl) - var(--space-3)); }    /* 4px */
  ```
  The formula: `inner-radius = outer-radius - gap`. If the gap is larger than the outer radius, the inner element should have `border-radius: 0`.
- **Consistency across a page.** If cards use `--radius-lg`, all cards use `--radius-lg`. Don't mix unless there's a semantic reason.

### Shadows
- **Tone-match shadows to the surface.** The Kortix palette's `--shadow-sm`, `--shadow-md`, and `--shadow-lg` variables use a warm-tinted shadow color. Reference them directly:
  ```css
  .card { box-shadow: var(--shadow-sm); }
  .card:hover { box-shadow: var(--shadow-md); }
  .floating-panel { box-shadow: var(--shadow-lg); }
  ```
  In Tailwind: use `shadow-sm`, `shadow-md`, `shadow-lg` and customize the color via `tailwind.config.ts` or `shadow-[0_4px_12px_oklch(0.2_0.01_80/0.08)]`.
- **Layered shadows feel more natural.** Two or three stacked shadows — a tight, sharp one for contact shadow + a wide, diffuse one for depth — creates realistic elevation:
  ```css
  .card {
    box-shadow:
      0 1px 2px oklch(0.2 0.01 80 / 0.06),
      0 4px 16px oklch(0.2 0.01 80 / 0.04);
  }
  .card:hover {
    box-shadow:
      0 2px 4px oklch(0.2 0.01 80 / 0.08),
      0 12px 32px oklch(0.2 0.01 80 / 0.06);
  }
  ```
- **Dark mode shadows need lower opacity** — on dark backgrounds, shadows are less visible. Increase spread or use a subtle light glow (`oklch(1 0 0 / 0.03)`) for elevation instead.
- **Use shadow for elevation, not emphasis.** A card with a shadow should feel "lifted" off the surface. Don't use shadows as visual decoration on flat elements that aren't elevated.

---

## Mobile-First Design

Every website must work beautifully on mobile.

- **Design at 375px first, then expand.** If the mobile experience feels complete, the desktop version will be better for it.
- **Touch targets: 44x44px minimum.** Buttons, links, nav items, form controls — anything tappable. Padding counts toward the target.
- **One column is your friend.** On mobile, a single-column flow with generous spacing is faster to scan than a cramped 2-column layout.
- **Bottom-anchored actions.** Primary CTAs and key actions should be within thumb reach. Consider sticky bottom bars for critical actions.
- **Collapse, don't shrink.** Bento grids become stacked cards. Side-by-side comparisons become tabs or carousels. Tables get a card view or horizontal scroll with a scroll hint.
- **Navigation transforms.** Five or fewer primary items → bottom tab bar. More → hamburger with grouped sections.
- **Typography adjusts.** Fluid type (`clamp()`) handles most of this. Verify hero text doesn't dominate the viewport and body text stays 16px+ (prevents iOS zoom on input focus).
- **Test at real breakpoints:** 375px (iPhone SE), 390px (iPhone 14), 768px (iPad), then 1024px+.
- **Tap states are mandatory.** Every interactive element needs a visible `:active` state so users get feedback that their tap registered.
- **Avoid hover-dependent UI on mobile.** Use tap/toggle patterns instead, or detect touch with `@media (hover: none)` and provide alternatives.

**Responsive utility pattern:**
```css
.section { padding: var(--space-6) var(--space-4); }
@media (min-width: 768px) { .section { padding: var(--space-12) var(--space-8); } }
@media (min-width: 1024px) { .section { padding: var(--space-16) var(--space-12); } }
@media (hover: none) { .tooltip-trigger:hover .tooltip { display:none; } .tooltip-trigger:focus-within .tooltip { display:block; } }
```

**Dashboard mobile:** Collapse sidebar to bottom tabs/hamburger. Stack KPIs vertically. Charts full-width. Tables → card lists or horizontal scroll. Single scroll region still applies.

---

## Backgrounds & Visual Depth

Most surfaces should be clean, warm neutrals from the surface token system. But **focal areas** — hero sections, feature highlights, key CTAs — can use depth techniques to create atmosphere. Apply these contextually to 1-2 areas per page, not everywhere.

**Techniques for focal areas (use sparingly):** gradient meshes (stacked radial/conic), CSS grain overlay (`feTurbulence` SVG filter at `opacity: 0.04`), `backdrop-filter: blur()`, geometric patterns (`repeating-linear-gradient`), layered `box-shadow`, `mix-blend-mode`, animated gradients via `@property`.