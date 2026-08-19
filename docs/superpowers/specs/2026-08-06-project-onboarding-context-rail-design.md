# Project onboarding context rail design

## Status

Selected by the user on 2026-08-06.

Implementation target: `apps/web/src/components/projects/project-onboarding-wizard.tsx` and its shared onboarding step components.

## Problem

The current wizard does not maintain one visual coordinate system.

- The main column changes from `560px` to `1040px` on the custom Slack path.
- Step height controls vertical centering. Headings move between short and long steps.
- Skip and Continue have equal width and visual weight.
- `ChoiceRow` represents both selections and immediate actions as radio controls.
- A leading icon replaces the visible radio indicator.
- Row descriptions truncate decision context.
- Progress is hidden from assistive technology.

The redesign must keep the primary decision column centered. Context can appear beside it, but context cannot move the primary column.

## Evidence

The Mobbin review found a repeated structure across current web onboarding flows:

- [Uxcel onboarding](https://mobbin.com/screens/32b3aa4d-745f-4e47-82c4-7595929e5fde) uses a narrow centered question and quiet progress.
- [Magnific onboarding](https://mobbin.com/screens/5f30270a-1678-4dae-8d4a-1b040688b26e) keeps choices compact and actions subordinate.
- [Grammarly onboarding](https://mobbin.com/screens/965e4e5e-731a-4408-9e18-9ff0df5ae986) separates the decision surface from progress and navigation.
- [Cloudflare onboarding](https://mobbin.com/screens/a7ccde8f-05f9-40cf-b7b8-29f4b7e76079) uses adjacent context without turning every step into a card.
- [Air workspace setup](https://mobbin.com/flows/4a12588a-cbb2-461e-966f-6a0ac1dfb88e) keeps one task per step and a stable visual system.

## Selected concept

Use a centered decision lane with a contextual rail.

The decision lane stays at the viewport's true horizontal center. The contextual rail appears to the right on wide screens. It stacks below the main content on smaller screens.

## Geometry

### Frame

- Keep the existing `8px` viewport inset.
- Keep `rounded-md` and `border-border/60` on the frame.
- Keep the top utility row at `56px`.
- Keep the frame flat. Do not add elevation.

### Decision lane

- Width: `520px`.
- Position: viewport center, independent of the context rail.
- Horizontal padding: `20px` on mobile and `32px` from `md`.
- Vertical padding: `32px`.
- Title baseline stays stable across steps.
- Long content scrolls inside the content region.

### Context rail

- Width: `340px`.
- Gap from the decision lane: `32px`.
- Desktop breakpoint: `xl` (`1280px`).
- Desktop position: absolute to the right of the centered lane.
- Maximum height: `min(560px, calc(100dvh - 160px))`.
- Mobile and tablet position: normal flow after step content and before actions.
- Surface: `bg-popover rounded-md border p-4`.
- No shadow, glow, gradient, or decorative illustration.
- The rail renders only when it carries functional context.

## Shared components

### `StepShell`

Keep `StepShell` as the shared step composition.

Add a `context?: ReactNode` slot. The frame controls desktop rail placement and mobile stacking.

The shell keeps one spacing scale:

- Title to description: `8px`.
- Header to content: `24px`.
- Row gap: `8px`.
- Content to actions: `32px`.

### `StepContext`

Add one shared context surface.

- Title: `text-sm font-medium`.
- Supporting text: `text-xs leading-5 text-muted-foreground`.
- Internal block gap: `16px`.
- Long content uses `FadedScrollArea`.

### Selection and action rows

Replace the overloaded `ChoiceRow` API with two semantic components.

`SelectionRow`:

- Represents one radio selection.
- Keeps a persistent trailing radio indicator.
- Uses `role="radio"` and `aria-checked` through the existing Radio Group primitive.
- Supports Arrow and Space keyboard behavior.

`ActionRow`:

- Represents an immediate action.
- Uses button semantics.
- Supports a trailing arrow, connected state, or `Loading`.
- Never exposes radio semantics.

Both rows share these visual rules:

- Minimum height: `56px`.
- Padding: `12px 16px`.
- Gap: `12px`.
- Radius: `rounded-md`.
- Label: `text-sm font-medium`.
- Description: `text-xs leading-4 text-pretty`.
- Descriptions wrap. They do not truncate.
- Selected state: `border-primary/40 bg-primary/[0.05]`.
- Row press: `scale(0.99)`.
- Transition only background color, border color, opacity, and transform.

### Progress

Keep the segmented visual.

Expose progress through:

- `role="progressbar"`.
- `aria-valuemin="1"`.
- `aria-valuemax={total}`.
- `aria-valuenow={current + 1}`.
- `aria-label="Setup progress"`.

## Step behavior

### Use case

- Render seven `SelectionRow` items.
- Continue remains disabled until selection.
- Secondary action label: `Skip survey`.
- No context rail.

### Company

- Keep domain and company size in the main lane.
- Use `Field`, `FieldLabel`, and `InputGroup`.
- Keep a `32px` gap between the two questions.
- Move the privacy explanation to a neutral `InfoBanner` or the context rail only if it improves the rendered balance.
- Continue never gates.

### Tools

- Use `InputGroupSearch`.
- Apps render as `ActionRow`.
- Connected apps display visible text and a semantic status icon.
- The context rail lists connected profiles and selected app authorization details.
- Secondary action label: `Skip for now`.

### Slack

- Keep managed install and custom install as `ActionRow` items.
- The main decision lane never moves.
- Render the custom Slack form in the context rail.
- Render OAuth waiting and connection status in the context rail.
- Below `xl`, stack the form after the chooser.
- Continue enables after connection.
- Secondary action label: `Not now`.

### Plan

- Render plan options as `SelectionRow`.
- Keep the connected model `InfoBanner`.
- The context rail explains the selected path and the result of Continue.
- Selection never opens a modal.
- Primary label remains contextual: `See plans`, `Add a key`, or `Continue`.

### Done

- Keep the success state and starter prompts in the main lane.
- Starter prompts render as `ActionRow`.
- The context rail shows a compact setup summary when useful data exists.
- Primary action label: `Open project`.
- The founder call remains a quiet secondary action.

## Action hierarchy

- Use a ghost secondary action.
- Use the default primary button.
- Do not give Skip and Continue equal width or equal contrast.
- Desktop actions align right with `12px` gap.
- Primary button minimum width: `144px`.
- Mobile actions become full width.
- Button labels cannot wrap.

## Motion

Frequency tier: rare, first-time onboarding.

Purposes:

- Direction-aware transition preserves spatial consistency.
- Crossfade prevents a jarring step replacement.
- Press feedback confirms direct interaction.

Values:

- Step enter: opacity plus `translateX(16px)`, `220ms`, `cubic-bezier(0.23, 1, 0.32, 1)`.
- Step exit: opacity plus the inverse `translateX(16px)`, `170ms`, same curve.
- Back reverses the direction.
- Context rail enter: opacity plus `translateX(12px)`, `200ms`.
- Context rail exit: opacity plus `translateX(12px)`, `150ms`.
- Button press: `scale(0.96)`, `150ms`.
- Row press: `scale(0.99)`, `150ms`.
- Reduced motion removes translation and scale. It keeps a `160ms` opacity fade.
- Do not animate width, height, margin, padding, top, or left.
- Do not add ambient motion.

## Accessibility

- Bind the dialog to the active step title with `aria-labelledby`.
- Bind the dialog to the active description with `aria-describedby` when present.
- Move focus to the new step heading or first field after navigation.
- Escape returns to the previous step. It does not dismiss onboarding.
- Announce OAuth waiting and connection results with `aria-live="polite"`.
- Keep visible focus rings.
- Keep controls at least `40px` high.
- Keep connected state text visible. Do not rely on color.
- Keep focused content visible above the actions.

## Data flow

The redesign does not change persisted onboarding data.

- `useOnboardingAnswers` remains the source of survey values.
- `buildSteps` remains the source of enabled steps.
- `useProjectOnboarding` remains the completion gate.
- Connector queries and mutations remain unchanged.
- `useModelConnectionGate` remains the plan action controller.
- `useComposerPrefillStore` remains the finish-step handoff.

Only presentation state changes:

- Active context rail content.
- Selected plan explanation.
- Slack custom form visibility.
- Focus target after step navigation.

## Error and loading behavior

- Use `Loading` for active connector and Slack operations.
- Use shape-matched `Skeleton` rows for catalogue loading.
- Keep `InfoBanner` for connector configuration failures and connected states.
- Keep existing toasts for reset and completion errors.
- Context rail errors stay inside the rail. They cannot move the decision lane.
- Empty app search uses plain functional copy in the main lane.

## Responsive behavior

### Below `1280px`

- Context stacks after main content.
- Context renders before the action row.
- Decision lane stays `max-w-[520px]`.

### Below `768px`

- Remove the outer gap, border, and radius.
- Use `min-h-[100dvh]`.
- Use `20px` horizontal padding.
- Keep the utility row fixed.
- Make actions full width.
- Keep safe-area padding below the actions.

### Short viewports

- Top-align the step body.
- Scroll only the content region.
- Keep progress and actions reachable.
- Do not use viewport-relative heights inside individual steps.

## Verification

### Automated

- Update source-shape tests for the `520px` lane and `340px` rail.
- Add semantic tests for `SelectionRow` and `ActionRow`.
- Keep motion direction, timing, and reduced-motion tests.
- Run focused onboarding tests with Bun.
- Run ESLint on every changed file.
- Run the web TypeScript gate and report the known unrelated Bun test typing errors separately.

### Browser

Verify the real wizard in Chromium at:

- `1440x900`.
- `1280x800`.
- `768x1024`.
- `390x844`.

For every breakpoint:

- The decision lane remains centered.
- The title baseline does not jump between steps.
- The context rail never shifts the main lane.
- Action priority is clear.
- Long descriptions wrap.
- Focus order matches visual order.
- Step motion reverses on Back.
- Reduced motion uses opacity only.

Verify these paths with DOM and network assertions:

- Use case selection and Continue.
- Company input and Skip.
- Tool search and connector action.
- Slack managed install waiting state.
- Slack custom form open and close.
- Plan selection and contextual primary label.
- Done prompt handoff and Open project.

## Out of scope

- Backend contract changes.
- Onboarding step additions or removals.
- Billing behavior changes.
- Connector authorization changes.
- New illustration or image assets.
- GSAP, scroll effects, ambient loops, or decorative motion.
