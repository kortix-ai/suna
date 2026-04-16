# Config Degradation UI — Visual Improvement Handover

## Goal

Improve the **visual prominence and polish** of the config-degradation warning in the **left sidebar**.

The functionality is already wired up and working. This is now a **visual / UX refinement task**, not a backend correctness task.

## Current state

- Runtime fail-soft behavior is already implemented and verified.
- The local sandbox is **currently intentionally degraded** for testing.
- Current live degraded source:
  - `/workspace/.opencode/opencode.jsonc`
- Current issue:
  - `Unrecognized key: "invalid_field"`
- Runtime remains healthy:
  - `/config/status` => `valid: false`
  - `/session/status` => `200`
  - `/kortix/health` => `runtimeReady: true`

## Primary UI location

The warning should be shown in the **left sidebar footer area**, near where the **update actions / update indicator** usually live.

The user explicitly wants this to feel:

- **hyperminimal**
- **clean**
- **elegant**
- clearly on **Kortix brand**

Avoid a loud, bulky, clunky warning block in the main sidebar body.

## Files most relevant

- `apps/web/src/components/sidebar/sidebar-left.tsx`
- `apps/web/src/app/instances/_components/instance-settings-modal.tsx`
- `core/kortix-master/src/routes/projects.ts`

## What already exists

In the sidebar warning we already have:

- degraded warning card in expanded sidebar
- pulsing warning icon in collapsed sidebar
- source path + error message
- `Copy fix prompt`
- `Start fix task`
- automatic creation of a `/workspace` Kortix project if none exists yet

## What should improve

Make it feel **hard to miss, polished, and intentional**, but still minimal.

Examples of acceptable improvement directions:

- stronger hierarchy / spacing / contrast without becoming noisy
- subtle but premium badge treatment for degraded state
- refined iconography / severity styling
- clearer primary CTA emphasis
- clearer distinction between "runtime healthy" and "config ignored"
- more compact but more legible source/error presentation
- improved collapsed-state affordance
- better placement in the **footer / update-actions area**

## Explicit negative guidance

Do **not** make this look like a giant warning slab or emergency dashboard block.

Avoid:

- oversized amber boxes
- visually noisy multi-panel stacks
- clunky enterprise alert styling
- overly aggressive warning aesthetics

The desired feel is more like:

- a premium degraded-state card / pill / compact module
- clearly visible, but still calm and brand-aligned

## Constraints

- Do **not** remove the existing functionality.
- Do **not** break the task-start flow.
- Do **not** change backend semantics unless absolutely necessary.
- Preserve the key message:
  - config is degraded
  - runtime is still healthy
  - user can fix it now

## User intent

The user wants this warning to be **very visible**, not hidden away in a modal or secondary settings area.

So optimize for:

- instant visibility
- quick comprehension
- obvious actionability

## Verification

Please verify all of the following:

1. `npm run build` in `apps/web` passes
2. local sandbox still shows degraded config via `/config/status`
3. the left sidebar visually shows the warning clearly
4. `Copy fix prompt` still works
5. `Start fix task` still works

## Manual test context

Frontend dev server is expected at:

- `http://localhost:3001`

Local sandbox is intentionally left degraded so the warning should be visible while testing.
