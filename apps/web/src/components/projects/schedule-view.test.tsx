import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { TriggerPauseSwitch } from './schedule-view';

/**
 * Pins the access-control fix from Task 18's review: `TriggerActivationMenu`
 * (the pause-all-triggers kill switch, rehomed here from the deleted
 * `settings-view.tsx`, and named `TriggersActivationCard` while it was a
 * banner) must stay manager-only, the same gate the deleted
 * code used — NOT `ScheduleView`'s own `canWrite` (`project.trigger.create`,
 * a `MANAGER_EXTRAS`-tier leaf per `apps/api/src/iam/role-perms.ts`), which
 * would let editors see and toggle it too. `TriggerPauseSwitch` is the pure
 * half of that gate — see its own header comment for why the split exists
 * (no DOM testing library in this repo, so a pure `canManage` prop is the
 * only way to pin "an editor doesn't see this" under `renderToStaticMarkup`).
 */
describe('TriggerPauseSwitch — manager-only access gate', () => {
  test('renders for a manager', () => {
    const out = renderToStaticMarkup(
      <TriggerPauseSwitch canManage paused={false} isPending={false} onToggle={() => {}} />,
    );
    expect(out).toContain('Pause all triggers');
    expect(out).toContain('role="switch"');
  });

  test('does not render for an editor (or any non-manager)', () => {
    const out = renderToStaticMarkup(
      <TriggerPauseSwitch canManage={false} paused={false} isPending={false} onToggle={() => {}} />,
    );
    expect(out).toBe('');
    expect(out).not.toContain('Pause all triggers');
  });

  test('reflects the paused state in its label', () => {
    const out = renderToStaticMarkup(
      <TriggerPauseSwitch canManage paused isPending={false} onToggle={() => {}} />,
    );
    expect(out).toContain('· paused');
    expect(out).toContain('aria-checked="true"');
  });

  test('a pending mutation disables the switch', () => {
    const out = renderToStaticMarkup(
      <TriggerPauseSwitch canManage paused={false} isPending onToggle={() => {}} />,
    );
    expect(out).toMatch(/role="switch"[^>]*disabled/);
  });
});

/**
 * Page chrome. Triggers is a sibling tab of Connectors / Agents / Skills and
 * has to read as one: same `CapabilityPageShell`, same `max-w-5xl` column,
 * same heading, same header group. It brought its own `max-w-2xl` column and
 * its own `SettingsSectionHeader` before, which is what made it look like a
 * different product.
 *
 * Source-level assertions, following `connectors-page.global-rules.test.ts`:
 * apps/web has no DOM testing library, and what is pinned here is WHERE a
 * control is mounted, not what it renders.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'schedule-view.tsx'), 'utf8');

/** Comments name the old layout on purpose; assert on code only. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const CHILDREN_START = '<div className="space-y-4">';
const shellStart = code.indexOf('<CapabilityPageShell');
const childrenStart = code.indexOf(CHILDREN_START);
/** The shell's props — `title`, `description`, `search`, `action`. */
const shellHeader = code.slice(shellStart, childrenStart);
/** Everything the shell renders as its content column. */
const shellChildren = code.slice(childrenStart);

describe('ScheduleView page chrome', () => {
  test('the page is the shared capability shell, not its own column', () => {
    expect(shellStart).toBeGreaterThan(-1);
    expect(childrenStart).toBeGreaterThan(shellStart);
    expect(shellHeader).toContain('title={copy.title}');
    expect(shellHeader).toContain('description={copy.description}');
    // The two pieces of the old narrow layout, gone for good.
    expect(code).not.toContain('max-w-2xl');
    expect(code).not.toContain('SettingsSectionHeader');
  });

  test('search and the create action are the shell’s slots, not inline', () => {
    expect(shellHeader).toContain('InputGroupSearchInput');
    expect(shellHeader).toContain('{copy.createLabel}');
    expect(shellChildren).not.toContain('InputGroupSearchInput');
  });

  const menu = code.slice(
    code.indexOf('function TriggerActivationMenu'),
    code.indexOf('export function ScheduleView'),
  );

  test('pause-all lives behind the header gear, not in the content flow', () => {
    expect(shellHeader).toContain('<TriggerActivationMenu projectId={projectId} />');
    expect(menu).toContain('aria-label="Trigger settings"');
    expect(menu).toContain('GearSixIcon');
    expect(menu).toContain('<PopoverTrigger asChild>');
    // Never back in the list column as a banner.
    expect(shellChildren).not.toContain('TriggerActivationMenu');
    expect(shellChildren).not.toContain('Pause all triggers');
  });

  test('the gear itself is manager-only — the same gate as the switch', () => {
    expect(menu).toContain("effective_project_role === 'manager'");
    expect(menu).toContain('if (!canManage) return null;');
    expect(menu).not.toContain('canWrite');
  });

  // The paused STATE is not the paused CONTROL: a project that runs nothing on
  // its own stays announced at the top of the list.
  test('the paused banner stays prominent in the content column', () => {
    expect(shellChildren).toContain('Everything is paused');
    expect(shellChildren).toContain('{paused && showContent &&');
  });
});
