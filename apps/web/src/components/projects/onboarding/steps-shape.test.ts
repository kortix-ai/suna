/**
 * Shape rules for individual steps that the column refactor depends on.
 *
 * These are source assertions for the same reason as `shell-layout.test.ts`:
 * "this step does not render a tile grid" and "this step never gates" are
 * properties of the markup, invisible to a rendering test that only ever
 * exercises the happy path.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const step = (name: string) => readFileSync(join(import.meta.dir, 'steps', name), 'utf8');
const stepShell = readFileSync(join(import.meta.dir, 'step-shell.tsx'), 'utf8');

const tools = step('tools-step.tsx');
const plan = step('plan-step.tsx');
const slack = step('slack-step.tsx');
const company = step('company-step.tsx');
const useCase = step('use-case-step.tsx');

describe('use-case step', () => {
  test('uses selection semantics for its single survey answer', () => {
    expect(useCase).toContain('<SelectionRow');
  });

  // Icons make the seven options scannable; SelectionRow already owns the slot.
  test('gives every use case a phosphor leading icon', () => {
    expect(useCase).toContain('@phosphor-icons/react');
    expect(useCase).toContain('USE_CASE_ICONS');
    expect(useCase).toContain('leading=');
  });
});

describe('tools step', () => {
  test('uses a vertical list, not a tile grid', () => {
    expect(tools).not.toContain('grid-cols-2');
    expect(tools).not.toContain('sm:grid-cols-3');
    expect(tools).toContain('<ActionRow');
  });

  test('does not present connection actions as one radio answer', () => {
    expect(tools).not.toContain('role="radiogroup"');
  });

  // The column sets the bound, not the viewport. A vh-relative height made this
  // the tallest step in the flow on large screens.
  test('does not pin its own viewport-relative height', () => {
    expect(tools).not.toContain('vh]');
  });

  // The step asks exactly one thing: which apps. The custom-API escape hatch
  // lives on the Connectors page, not inside onboarding.
  test('asks one thing — no tabs, no custom-API branch', () => {
    expect(tools).not.toContain('<Tabs');
    expect(tools).not.toContain('TabsTrigger');
    expect(tools).not.toContain('Connect a custom API');
    expect(tools).not.toContain('CustomConnectorForm');
  });

  // The fade says "there is more" without putting a scrollbar on screen.
  test('fades the scroll edges instead of showing a hard cut', () => {
    expect(tools).toContain('FadedScrollArea');
  });

  test('keeps the accessible name that distinguishes adding another connection', () => {
    expect(tools).toContain('aria-label={`Add ${app.name} connection`}');
  });

  test('shows connected state as status without exposing a toggle', () => {
    expect(tools).not.toContain('active={existingSlugs.includes(app.slug)}');
    expect(tools).toContain('<Badge');
    expect(tools).toContain('variant="success"');
    expect(tools).toContain('Connected');
  });

  test('exposes connected status as the add action description', () => {
    expect(tools).toContain('aria-describedby={connected ? connectedStatusId : undefined}');
    expect(tools).toContain('id={connectedStatusId}');
    expect(stepShell).toContain("'aria-describedby': ariaDescribedBy");
    expect(stepShell).toContain('aria-describedby={ariaDescribedBy}');
  });
});

describe('slack step', () => {
  // Was a bordered card, a button inside it, and a disclosure beneath — three
  // unrelated shapes on a screen where every other step is a list of rows.
  test('offers both install paths as the shared row primitive', () => {
    expect(slack).toContain('<ActionRow');
    expect(slack).toContain('Add to Slack');
    expect(slack).toContain('Use a custom Slack app');
  });

  test('exposes the install-method label as a group name', () => {
    expect(slack).toContain('role="group"');
    expect(slack).toContain('aria-label="Slack install method"');
  });

  test('collapses to a single confirmed state once connected', () => {
    expect(slack).toContain('Connected to Slack');
  });

  // The custom-app setup sits under the chooser in the same decision lane. An
  // earlier pass opened a side context panel, which pulled the lane off centre.
  test('opens the custom app inline in the decision lane', () => {
    expect(slack).not.toContain('StepContext');
    expect(slack).not.toContain('xl:flex-row');
    expect(slack).toContain('Bring your own Slack app');
    expect(slack).toContain('customOpen &&');
  });

  // The chunk downloaded and parsed during the open animation, dropping frames
  // for reasons that had nothing to do with easing.
  test('preloads the lazy form before the click', () => {
    expect(slack).toContain('onPreload={preloadConnectorsView}');
    expect(slack).toContain('const preloadConnectorsView');
  });

  // The manifest block is tall. Sizing the panel to it grew the row far past
  // the chooser, and the wizard centres its body vertically, so the whole step
  // lurched upward as the panel appeared.
  test('bounds the panel height so the row does not lurch', () => {
    expect(slack).toContain('max-h-[380px]');
    // The Suspense fallback matches the loaded height — otherwise skeleton to
    // form is a second reflow mid-animation.
    expect(slack).toContain('h-[380px]');
  });
});

describe('company step', () => {
  test('uses an input group with an icon for the domain', () => {
    expect(company).toContain('InputGroup');
    expect(company).toContain('GlobeIcon');
  });

  // Two separate questions on one screen must read as two, not as a form.
  test('separates the two questions properly', () => {
    expect(company).toContain('space-y-8');
    expect(company).not.toContain('space-y-10');
  });

  // Invalid non-empty domain shakes the whole InputGroup, not just the input.
  test('wires domain validation into a group-level shake', () => {
    expect(company).toContain('isValidCompanyHttpLink');
    expect(company).toContain('aria-invalid={domainInvalid || undefined}');
    expect(company).toContain("domainInvalid && 'motion-safe:animate-shake'");
    expect(company).toContain('aria-invalid:animate-none');
  });
});

describe('plan step', () => {
  test('reuses the shared model-connection gate rather than new billing wiring', () => {
    expect(plan).toContain('useModelConnectionGate');
    expect(plan).not.toContain('useUpgradeDialogStore');
  });

  /**
   * THE `/new` dead-click fix. The gate falls back to the `[id]` route segment
   * when nobody tells it which project to act on, and `/new` (`app/(app)/new`)
   * has no such segment — so an inferred project is `null`, `modal` is `null`,
   * and "Add a key" opens nothing while never calling `onContinue()`. This step
   * is 5 of 6 and passes no `onSkip` to `StepShell`, so its primary button is
   * the only control: an inferred id strands the user mid-wizard.
   */
  test('tells the gate which project it is acting on instead of letting it infer the route', () => {
    expect(plan).toContain('projectId');
    expect(plan).toContain('useModelConnectionGate(flattenModels(providers), { projectId })');
  });

  // The composer enforces model connection later. Blocking here would strand a
  // user who wants to look around before paying.
  test('never gates — Continue carries no disabled condition', () => {
    expect(plan).not.toContain('primaryDisabled');
  });

  // With billing disabled there is no <GlobalUpgradeModal/> mounted to respond,
  // so an Upgrade row would be a dead click.
  test('hides the paid option when billing is unavailable', () => {
    expect(plan).toContain('showUpgradeOption');
  });

  test('offers three ways forward, including deferring', () => {
    expect(plan).toContain('<SelectionRow');
    expect(plan).toContain('Use Kortix models');
    expect(plan).toContain('Bring your own API key');
    expect(plan).toContain('Decide later');
  });

  // THE fix for this step. Clicking a row used to fire a modal instantly: the
  // user taps to consider an option, gets a whole separate flow thrown at them,
  // backs out, and loses the thread. Selection must only select.
  test('opens nothing on selection — the action is deferred to Continue', () => {
    expect(plan).not.toContain('openUpgrade();\n            }}');
    expect(plan).toContain('const handleContinue');
    // The controlled group does exactly one thing on selection: record the choice.
    expect(plan).toContain("value={choice ?? ''}");
    expect(plan).toContain('onValueChange={(nextChoice) => setChoice(nextChoice as PlanChoice)}');
  });

  // The modal that opens should never be a surprise, so the button names it.
  test('labels the primary with what it will actually do', () => {
    expect(plan).toContain("'See plans'");
    expect(plan).toContain("'Add a key'");
  });

  test('describes BYOK accurately with and without an existing model', () => {
    expect(plan).toContain(
      "label={hasSelectableModels ? 'Connect another provider' : 'Bring your own API key'}",
    );
    expect(plan).toContain(
      "label={hasSelectableModels ? 'Keep what I have' : 'Decide later'}",
    );
  });

  // An earlier version short-circuited to a confirm-only screen when a model
  // was already connected, which stranded anyone who wanted to add a second
  // provider or move onto a plan. A connected model is context, not an answer.
  test('keeps every option available even when a model is already connected', () => {
    expect(plan).not.toContain('if (hasSelectableModels)');
    expect(plan).toContain('Connect another provider');
    expect(plan).toContain('Keep what I have');
  });
});
