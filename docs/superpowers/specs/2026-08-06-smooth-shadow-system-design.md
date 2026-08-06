# Smooth shadow system — design

**Date:** 2026-08-06
**Branch:** `shadow-plugin`
**Baseline:** `897f7acf6d`
**Surface:** all of `apps/web`
**Dependency:** `shadow-plugin@2.1.0`

## Problem

`apps/web` uses Tailwind's native `shadow-*` utilities across product,
marketing, documentation, and debug routes. The current CSS does not define
the Kortix elevation tokens described by the design-system skill. Tailwind
therefore renders its stock shadows.

The codebase also pairs borders or rings with shadows on some elevated
surfaces. Those pairs can draw two adjacent edges: one hard stroke and one
soft shadow edge. The result conflicts with the calm Kortix surface language.

The requested default is the Smooth Shadow Plugin treatment represented by:

```tsx
<div className="smooth-shadow-ring shadow-black smooth-ring-neutral-300/30" />
```

Developers must not need to learn a new class for normal Kortix elevation.
Existing `shadow-sm`, `shadow-md`, and `shadow-lg` call sites must receive the
new treatment from one global configuration.

## Evidence

- `apps/web` uses Tailwind CSS `4.3.2`.
- `shadow-plugin` version `2.1.0` is the current npm release.
- The plugin exposes `smooth-shadow-*`, `smooth-shadow-ring-*`, and
  `smooth-ring-*` utilities.
- The plugin's unprefixed entry point replaces native shadow stacks but does
  not add its independent hairline ring.
- `apps/web/src` contains shadow usage in 107 files.
- Native `shadow-sm`, `shadow-md`, and `shadow-lg` occur across 43 files.
- Some elevated surfaces combine these classes with `border` or `ring-*`.
- Commit `98e5fd0a72` removed the previous custom Kortix shadow ladder from
  `globals.css`. The design-system documentation still claims that ladder is
  active, so the documentation and implementation disagree.

## Goals

1. Install and use `shadow-plugin` as the shadow-stack source.
2. Keep `shadow-sm`, `shadow-md`, and `shadow-lg` as the standard Kortix API.
3. Give each standard class the matching smooth stack and a neutral 30% ring.
4. Keep shadow and ring colors independently customizable.
5. Preserve explicit plugin utilities for exceptional surfaces.
6. Remove double edges from elevated surfaces across all `apps/web` routes.
7. Preserve structural separators, accessibility focus indicators, and
   semantic status rings.
8. Document and demonstrate the final contract in the living design system.
9. Prove the result in light and dark themes with compiled CSS assertions and
   browser checks.

## Non-goals

- Adding shadows to every card or in-flow panel.
- Changing `apps/mobile` or `apps/whitelabel-demo`.
- Replacing `drop-shadow-*`; those utilities follow image alpha and serve a
  different purpose.
- Redesigning spacing, typography, color, or radius outside changes required
  to remove a shadow edge defect.
- Copying every plugin shadow formula into Kortix-owned CSS.

## 1. Public interface

The common interface remains three native Tailwind classes:

```tsx
<FloatingControl className="shadow-sm" />
<PopoverContent className="shadow-md" />
<ModalContent className="shadow-lg" />
```

The semantic mapping is:

- `shadow-sm`: compact floating controls and raised active states.
- `shadow-md`: popovers, menus, dropdowns, and compact floating panels.
- `shadow-lg`: modals, sheets, toasts, and substantial overlays.

The explicit interface remains available for exceptions:

```tsx
<div className="smooth-shadow-md" />
<div className="smooth-shadow-ring-xl shadow-black smooth-ring-neutral-300/30" />
<div className="smooth-shadow-ring-md shadow-kortix-green/20 smooth-ring-kortix-green" />
```

Use `smooth-shadow-*` for a ringless shadow. Use
`smooth-shadow-ring-*` when a surface needs a non-standard size or ring.

## 2. Global integration

`apps/web/src/app/globals.css` imports the plugin after Tailwind and owns the
three aliases:

```css
@import 'tailwindcss';
@import 'shadow-plugin';

@utility shadow-sm {
  @apply smooth-shadow-ring-sm smooth-ring-neutral-300/30;
}

@utility shadow-md {
  @apply smooth-shadow-ring-md smooth-ring-neutral-300/30;
}

@utility shadow-lg {
  @apply smooth-shadow-ring-lg smooth-ring-neutral-300/30;
}
```

The plugin defaults the shadow color to black. An explicit `shadow-{color}`
utility overrides only the shadow color. An explicit `smooth-ring-{color}`
utility overrides only the ring color.

Do not map `--shadow-*` to `var(--smooth-shadow-*)`. The plugin documentation
states that this prevents Tailwind from processing shadow colors and opacity
modifiers correctly.

The first implementation ticket must compile this exact adapter against the
installed Tailwind version. If Tailwind does not give the local utility final
precedence for base and variant classes, the implementation must use a tested
local adapter with the same public interface. Component call sites must not
absorb plugin formulas.

## 3. Surface audit rules

Every `apps/web` shadow call site is classified before editing.

### Elevated surface

Examples include dialogs, menus, popovers, sheets, toasts, floating toolbars,
and detached previews.

- Keep the correct `shadow-sm`, `shadow-md`, or `shadow-lg` class.
- Remove a full border or `ring-1` when it exists only to draw the elevated
  surface edge.
- Use the baked smooth ring as the edge.

### Structural edge

Examples include table boundaries, dividers, and sidebar seams.

- Preserve directional borders such as `border-r` and `border-b`.
- Use `smooth-shadow-*` without a baked ring if a structural border and a
  shadow must coexist on the same element.

### Semantic or accessibility ring

Examples include keyboard focus, selection, validation, and speaking state.

- Preserve the semantic state.
- Do not allow the smooth ring to erase a focus indicator.
- Convert a decorative Tailwind ring to `smooth-ring-*` when it represents the
  elevated edge.
- Use an outline or a separate element when the state ring and the elevation
  ring must remain independently visible.

### In-flow surface

Examples include settings panels, rows, tables, and ordinary cards within page
layout.

- Keep the surface flat unless elevation communicates a real stacking change.
- Remove an ornamental shadow when the design system already uses a border or
  substrate change for separation.

### Media shadow

- Preserve `drop-shadow-*` on transparent artwork.
- Review `shadow-*` on images and document previews separately. Their edge can
  be an image outline rather than an elevated-surface ring.

## 4. Component ownership

Shared primitives own repeated behavior:

- `menu-recipe.ts` owns dropdown, context-menu, select, and popover elevation.
- `modal.tsx` owns modal elevation.
- `toast.tsx` owns toast elevation.
- Other shared primitives own their standard elevation where one exists.

Feature code must not repeat a custom shadow stack already represented by a
shared primitive. Feature-only floating surfaces can use the standard native
class directly.

The audit changes only files that need one of these outcomes:

1. remove a duplicate decorative edge;
2. preserve a structural or semantic edge with a ringless shadow;
3. remove elevation from an in-flow surface;
4. replace a bespoke shadow with the global API.

## 5. Error and compatibility handling

The migration must test these CSS composition cases before broad edits:

- `shadow-sm`, `shadow-md`, and `shadow-lg`;
- responsive, hover, group, and data-state variants;
- `shadow-none` overriding an active standard shadow;
- `shadow-{color}` changing the shadow without changing the ring;
- `smooth-ring-{color}` changing the ring without changing the shadow;
- focus or status rings on an elevated element;
- class merging through `cn()` when native and explicit plugin sizes meet.

If native and explicit plugin size utilities do not follow last-class-wins
behavior through `tailwind-merge`, explicit plugin utilities must replace the
native size class. Do not stack both size classes on one element.

The dependency is pinned through the workspace lockfile. A future plugin
upgrade requires the same compile-contract and visual checks.

## 6. Documentation and discoverability

The implementation updates:

- the Shadows section on `/design-system`;
- `.claude/skills/kortix-design-system/SKILL.md`;
- any component comments that claim borders and shadows must always coexist;
- focused tests that encode the shadow contract.

The documentation states:

- standard elevation uses `shadow-sm`, `shadow-md`, or `shadow-lg`;
- standard elevation already includes the neutral hairline ring;
- do not add a decorative border to a standard elevated surface;
- use explicit plugin utilities for custom size, tint, ring color, or ringless
  depth;
- in-flow panels remain flat.

## 7. Verification

### Static and compile checks

1. Compile the web stylesheet with Tailwind `4.3.2` and
   `shadow-plugin@2.1.0`.
2. Assert the generated standard classes contain the plugin stack and final
   neutral ring layer.
3. Assert shadow and ring tint overrides remain independent.
4. Assert variants and `shadow-none` resolve correctly.
5. Run focused unit tests for shadow-contract and `cn()` composition behavior.
6. Run focused ESLint, the web typecheck, and affected component tests.

### Browser checks

Test both light and dark themes at desktop and narrow widths.

Representative surfaces:

- `/design-system` shadow examples;
- dropdown, context menu, select, and popover;
- modal, sheet, and toast;
- active tab or segmented control;
- sidebar or floating action panel;
- file viewer floating controls;
- marketing and documentation surfaces.

For each surface, record the computed `box-shadow` and verify the visible edge.
Keyboard-test affected focusable elements. Capture screenshots for the design
system and representative overlays.

### Deployment checks

After merge, follow the Deploy Dev workflow. Confirm the deployed web artifact
contains the merge SHA. Repeat the design-system and representative overlay
checks on `https://dev.kortix.com` in both themes.

## 8. Delivery and tracking

The implementation uses scoped tickets for:

1. plugin installation and compile-contract tests;
2. the global native-class adapter;
3. shared primitive edge migration;
4. feature, marketing, documentation, and debug-route audit;
5. design-system documentation and examples;
6. local and dev visual verification.

A Linear project in the Jay team mirrors this specification and the approved
implementation plan. Every ticket receives a milestone and real dependency
links. Work moves `Backlog` to `In Progress` when it starts and reaches `Done`
only after merge, deployment, and dev verification.

## Acceptance criteria

1. `shadow-sm`, `shadow-md`, and `shadow-lg` render matching plugin smooth
   shadow-ring stacks across all `apps/web` routes.
2. The standard ring equals `smooth-ring-neutral-300/30`.
3. Explicit shadow and ring colors remain independent.
4. Elevated surfaces do not show a duplicate decorative edge.
5. Structural borders, status rings, and keyboard focus indicators remain
   visible and semantically correct.
6. In-flow surfaces do not gain elevation without a stacking reason.
7. `/design-system` documents and renders the standard and explicit APIs.
8. Focused tests, typecheck, lint, and local browser verification pass.
9. The merged SHA is deployed and verified on `dev.kortix.com`.
