/**
 * Shape rules for the three steps.
 *
 * Source assertions, like `shell-layout.test.ts`: "this step opens no modal"
 * and "this step signs in to nothing" are properties of the markup and the
 * imports, invisible to a rendering test of the happy path.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const step = (name: string) => readFileSync(join(import.meta.dir, 'steps', name), 'utf8');

const work = step('work-step.tsx');
const apps = step('apps-step.tsx');
const plan = step('plan-step.tsx');

describe('work step', () => {
  test('is one pick from the shared option list', () => {
    expect(work).toContain('WORK_OPTIONS.map(');
    expect(work).toContain('RadioGroupPrimitive.Root');
  });

  test('opens a capped field only for "Something else"', () => {
    expect(work).toContain("const other = value === 'other'");
    expect(work).toContain('{other && (');
    expect(work).toContain('maxLength={USE_CASE_NOTE_MAX}');
  });

  test('cannot continue without a pick', () => {
    expect(work).toContain('primaryDisabled={value === null}');
  });
});

describe('apps step', () => {
  // One click connects. No modal and no name to type between the click and
  // the sign-in popup.
  test('a tile click connects, with no modal in between', () => {
    expect(apps).toContain('onConnect({ slug: app.slug, name: app.name, provider })');
    expect(apps).not.toContain('Modal');
  });

  // A connected tile never signs in again; the click is a no-op.
  test('a connected tile does not reconnect', () => {
    expect(apps).toContain("if (state === 'idle') onConnect(");
  });

  // Inside a <button> the spinner defaults to `text-background` and vanished
  // on the tile in dark mode.
  test('the spinner and the check use the foreground ink', () => {
    expect(apps).toContain('<Loading variant="spokes" className="text-foreground! size-4" />');
    expect(apps).toContain('<CheckCircleIcon weight="fill" className="text-foreground size-4" />');
    expect(apps).not.toContain('text-kortix-green');
  });

  test('shows a live count and no per-tile status text', () => {
    expect(apps).not.toContain("t('connect')");
    expect(apps).not.toContain("t('connecting')");
    expect(apps).toContain("t('connectedCount', { count: connectedCount })");
    expect(apps).toContain('grid-cols-3');
  });

  // Connecting nothing is a valid answer.
  test('Continue never waits for a connection', () => {
    expect(apps).not.toContain('primaryDisabled');
  });

  test('clears a typed search with one click and shows a spinner while searching', () => {
    expect(apps).toContain('{q && (');
    expect(apps).toContain('<InputGroupSearchClear');
    expect(apps).toContain("q.trim() !== query || apps.isFetching");
    expect(apps).toContain('<Loading variant="spokes" className="size-4" />');
  });

  test('searches the catalogue without a request per keystroke', () => {
    expect(apps).toContain('useDebounce(');
    expect(apps).toContain('placeholderData: (previous) => previous');
  });
});

describe('models step', () => {
  test('reuses the shared model-connection gate rather than new billing wiring', () => {
    expect(plan).toContain('useModelConnectionGate');
    expect(plan).not.toContain('useUpgradeDialogStore');
  });

  // THE `/new` dead-click fix: the gate must be told the project, because
  // `/new` (`app/[locale]/(app)/new`) has no `[id]` route segment to infer it from.
  test('tells the gate which project it is acting on', () => {
    expect(plan).toContain('{ projectId },');
    expect(plan).toContain('projectId: string;');
  });

  // THE reported bug: after adding a key the button still said "Add a key".
  test('derives the primary label from what is connected, not only the pick', () => {
    expect(plan).toContain('const action = planAction(choice, access)');
    expect(plan).not.toContain("choice === 'byok' ? t('addKey')");
  });

  test('never gates — the composer asks for a model when it needs one', () => {
    expect(plan).not.toContain('primaryDisabled');
    expect(plan).toContain('onSkip={onContinue}');
  });

  test('hides the Kortix option when there is neither billing nor a managed model', () => {
    expect(plan).toContain('const offerKortix = showUpgradeOption || access.hasKortixModels');
    expect(plan).toContain('{offerKortix && (');
  });

  test('opens nothing on selection — the action waits for Continue', () => {
    expect(plan).toContain('const handleContinue');
    expect(plan).toContain('onValueChange={(next) => setPicked(next as PlanChoice)}');
  });
});
