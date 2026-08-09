import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TriggerPauseSwitch } from './schedule-view';

/**
 * Pins the access-control fix from Task 18's review: `TriggersActivationCard`
 * (the pause-all-triggers kill switch, rehomed here from the deleted
 * `settings-view.tsx`) must stay manager-only, the same gate the deleted
 * code used — NOT `ScheduleView`'s own `canWrite` (`project.trigger.create`,
 * an `EDITOR_EXTRAS`-tier leaf per `apps/api/src/iam/role-perms.ts`), which
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
