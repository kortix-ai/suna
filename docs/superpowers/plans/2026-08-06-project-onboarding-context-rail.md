# Project Onboarding Context Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild project onboarding around a 520px centered decision lane and a conditional 340px functional context rail.

**Architecture:** `ProjectOnboardingWizard` owns the modal frame, progress, focus movement, and step navigation. `step-shell.tsx` owns shared step composition plus semantic selection, action, and context primitives. Individual steps keep all existing data hooks and mutations while adopting the shared primitives and supplying functional context.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Motion 12, Radix UI, Bun tests, Playwright CLI.

## Global Constraints

- Work in the current primary checkout on branch `onboarding`.
- Keep the decision lane at `520px` and the context rail at `340px` with a `32px` gap.
- Use only semantic color tokens and `kortix-*` accents.
- Use `rounded-md` for app panels and rows.
- Use Phosphor `*Icon` exports without `weight`, except existing solid status intent.
- Use `Loading` for every pending spinner.
- Use `Modal` for the blocking onboarding surface.
- Do not change SDK, API, billing, connector, or persisted onboarding contracts.
- Do not animate width, height, margin, padding, top, or left.
- Reduced motion keeps opacity fades and removes translation and scale.
- Do not add dependencies.

---

## File Structure

- Modify `apps/web/src/components/projects/project-onboarding-wizard.tsx`: canonical modal frame, fixed centered lane, accessible progress binding, Escape-back behavior, and focus movement.
- Modify `apps/web/src/components/projects/onboarding/step-shell.tsx`: `StepShell`, `StepContext`, `SelectionRow`, `ActionRow`, and accessible `StepProgress`.
- Modify `apps/web/src/components/projects/onboarding/motion.ts`: context-rail variants and the selected transition distances and durations.
- Modify all files under `apps/web/src/components/projects/onboarding/steps/`: migrate semantics and supply functional context.
- Modify onboarding tests under `apps/web/src/components/projects/onboarding/`: protect geometry, semantics, context behavior, and motion.
- Keep `apps/web/src/components/projects/onboarding/onboarding-profile.ts` unchanged.

### Task 1: Protect the selected geometry and semantics

**Files:**
- Modify: `apps/web/src/components/projects/onboarding/shell-layout.test.ts`
- Modify: `apps/web/src/components/projects/onboarding/steps-shape.test.ts`
- Modify: `apps/web/src/components/projects/onboarding/done-step.test.ts`
- Modify: `apps/web/src/components/projects/onboarding/motion.test.ts`

**Interfaces:**
- Produces assertions for `SelectionRow`, `ActionRow`, `StepContext`, `max-w-[520px]`, `w-[340px]`, `role="progressbar"`, and context motion.

- [ ] **Step 1: Replace the old 560px and `ChoiceRow` assertions**

```ts
expect(shell).toContain('max-w-[520px]');
expect(stepShell).toContain('w-[340px]');
expect(stepShell).toContain('role="progressbar"');
expect(useCase).toContain('<SelectionRow');
expect(tools).toContain('<ActionRow');
```

- [ ] **Step 2: Add rail isolation and semantic assertions**

```ts
expect(shell).not.toContain("stepId === 'slack' ?");
expect(slack).toContain('<StepContext');
expect(slack).not.toContain('xl:flex-row');
expect(tools).not.toContain('role="radiogroup"');
```

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```bash
pnpm --filter web test apps/web/src/components/projects/onboarding/shell-layout.test.ts apps/web/src/components/projects/onboarding/steps-shape.test.ts apps/web/src/components/projects/onboarding/motion.test.ts apps/web/src/components/projects/onboarding/done-step.test.ts
```

Expected: FAIL because the new primitives and geometry do not exist.

### Task 2: Build the shared frame and row primitives

**Files:**
- Modify: `apps/web/src/components/projects/project-onboarding-wizard.tsx`
- Modify: `apps/web/src/components/projects/onboarding/step-shell.tsx`
- Modify: `apps/web/src/components/projects/onboarding/motion.ts`

**Interfaces:**
- Produces: `StepContext`, `SelectionRow`, `ActionRow`, and `contextVariants(reduced)`.
- `SelectionRow` consumes `value`, `label`, `description`, `leading`, and `disabled` inside `RadioGroup`.
- `ActionRow` consumes `label`, `description`, `leading`, `trailing`, `active`, `disabled`, `onSelect`, and `onPreload`.
- `StepShell` adds `context?: ReactNode`.

- [ ] **Step 1: Implement the accessible segmented progress**

```tsx
<div
  role="progressbar"
  aria-label="Setup progress"
  aria-valuemin={1}
  aria-valuemax={total}
  aria-valuenow={current + 1}
>
```

- [ ] **Step 2: Implement `SelectionRow` with the existing Radio Group**

```tsx
<label className="has-data-[state=checked]:border-primary/40 has-data-[state=checked]:bg-primary/[0.05] ...">
  {leading}
  <span className="min-w-0 flex-1">...</span>
  <RadioGroupItem value={value} />
</label>
```

- [ ] **Step 3: Implement `ActionRow` with button semantics**

```tsx
<button type="button" onClick={onSelect} className={rowClassName}>
  {leading}
  <span className="min-w-0 flex-1">...</span>
  {trailing}
</button>
```

- [ ] **Step 4: Add `StepContext` and rail positioning**

```tsx
<motion.aside
  variants={contextVariants(reduced)}
  className="mt-6 w-full xl:absolute xl:left-[calc(100%+2rem)] xl:top-0 xl:mt-0 xl:w-[340px]"
>
```

- [ ] **Step 5: Rebuild the wizard frame with `Modal`**

Use `ModalContent` with `animation="none"`, `showCloseButton={false}`, `closeOnOutsideClick={false}`, and full inset overrides. Keep the main wrapper at `max-w-[520px]` for every step.

- [ ] **Step 6: Add Escape-back and focus movement**

```tsx
onEscapeKeyDown={(event) => {
  event.preventDefault();
  if (index > 0) back();
}}
```

After `stepId` changes, focus `#onboarding-step-title` on the next animation frame.

- [ ] **Step 7: Run focused tests**

Run the Task 1 command. Expected: shared-shell assertions pass. Step migration assertions can still fail.

### Task 3: Migrate every step and add functional context

**Files:**
- Modify: `apps/web/src/components/projects/onboarding/steps/use-case-step.tsx`
- Modify: `apps/web/src/components/projects/onboarding/steps/company-step.tsx`
- Modify: `apps/web/src/components/projects/onboarding/steps/tools-step.tsx`
- Modify: `apps/web/src/components/projects/onboarding/steps/slack-step.tsx`
- Modify: `apps/web/src/components/projects/onboarding/steps/plan-step.tsx`
- Modify: `apps/web/src/components/projects/onboarding/steps/done-step.tsx`

**Interfaces:**
- Consumes the Task 2 primitives.
- Keeps all existing callback and hook signatures.

- [ ] **Step 1: Migrate use case and company selection groups**

Wrap each list in controlled `RadioGroup` and render `SelectionRow`. Use case remains gated. Company remains optional.

- [ ] **Step 2: Migrate tools to action semantics**

Use `InputGroupSearch`. Render apps as `ActionRow`. Add a `StepContext` that reports connected profile count and explains authorization.

- [ ] **Step 3: Move the custom Slack form into the rail**

Remove the widening flex layout and layout spring. Render the lazy `SlackConnectForm` inside `StepContext`. Keep its `380px` bounded scroll and matching skeleton.

- [ ] **Step 4: Migrate plan selection and contextual explanation**

Use controlled `RadioGroup`. Render a `StepContext` whose title and copy derive from `choice`, `hasSelectableModels`, and `showUpgradeOption`. Keep modal actions deferred until Continue.

- [ ] **Step 5: Migrate done prompts to action rows**

Keep the prompt handoff unchanged. Add a setup-summary `StepContext` when `profileCount > 0`. Rename the primary to `Open project`.

- [ ] **Step 6: Run focused tests**

Run the Task 1 command. Expected: PASS.

### Task 4: Verify code quality and the real UI

**Files:**
- Verify all changed onboarding files.
- Store browser artifacts under `output/playwright/`.

**Interfaces:**
- Produces test, lint, type, DOM, network, and screenshot evidence.

- [ ] **Step 1: Run ESLint on changed files**

```bash
pnpm --filter web exec eslint apps/web/src/components/projects/project-onboarding-wizard.tsx apps/web/src/components/projects/onboarding/**/*.tsx apps/web/src/components/projects/onboarding/**/*.ts
```

Expected: zero errors.

- [ ] **Step 2: Run the web TypeScript gate**

```bash
pnpm --filter web exec tsc --noEmit
```

Expected: no new onboarding errors. Report only the repository's known Bun `test.each` type errors if present.

- [ ] **Step 3: Run all focused onboarding tests**

```bash
pnpm --filter web test apps/web/src/components/projects/onboarding
```

Expected: PASS.

- [ ] **Step 4: Verify desktop layouts in Chromium**

Use Playwright CLI at `1440x900` and `1280x800`. Assert the decision lane center does not change when the Slack context rail opens.

- [ ] **Step 5: Verify tablet and mobile layouts in Chromium**

Use `768x1024` and `390x844`. Assert the rail stacks before actions, descriptions wrap, controls remain visible, and no horizontal overflow exists.

- [ ] **Step 6: Verify interaction and motion contracts**

Exercise Continue, Back, Skip, Slack custom setup, plan selection, and starter prompt paths. Confirm reverse direction on Back and opacity-only behavior under reduced motion.

- [ ] **Step 7: Commit the implementation**

```bash
git add apps/web/src/components/projects/project-onboarding-wizard.tsx apps/web/src/components/projects/onboarding
git commit -m "feat(web): redesign project onboarding"
```

### Task 5: Deliver through dev

**Files:**
- No source changes unless CI or dev verification finds a defect.

- [ ] **Step 1: Push branch `onboarding`**
- [ ] **Step 2: Open a PR against `main`**
- [ ] **Step 3: Wait for required checks and fix failures**
- [ ] **Step 4: Merge the PR**
- [ ] **Step 5: Follow Deploy Dev and verify the merged SHA in the deployed artifact**
- [ ] **Step 6: Repeat the browser assertions against `https://dev.kortix.com`**
