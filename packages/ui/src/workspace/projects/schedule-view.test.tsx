import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../primitives/tooltip';
import { TriggerToolbarMenu } from './schedule-view';
import { readTriggerSheet, triggerSheetHref } from '../../customize/triggers/schedule/trigger-filter';

/**
 * The toolbar ⋯ menu holds the project-wide pause (`TriggerActivationMenu`).
 * It stays gated on the update control, NOT `ScheduleView`'s own `canWrite`
 * (`project.trigger.create`). `TriggerToolbarMenu` is the pure half of that
 * gate. The menu content renders in a portal on open, so only its trigger is
 * asserted here.
 */
function render(props: Parameters<typeof TriggerToolbarMenu>[0]) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TriggerToolbarMenu {...props} />
    </TooltipProvider>,
  );
}

const menuProps = { paused: false, isPending: false, onToggle: () => {} };

describe('TriggerToolbarMenu — manager-only access gate', () => {
  test('renders the ⋯ menu button for a manager', () => {
    const out = render({ ...menuProps, canManage: true });
    expect(out).toContain('aria-label="More"');
    expect(out).toContain('aria-haspopup="menu"');
  });

  test('does not render for an editor (or any non-manager)', () => {
    expect(render({ ...menuProps, canManage: false })).toBe('');
  });

  test('a pending mutation disables the button', () => {
    expect(render({ ...menuProps, canManage: true, isPending: true })).toMatch(
      /<button[^>]*disabled/,
    );
  });
});

/** The open trigger lives in the URL: open, switch, tab, close and a deep link. */
describe('trigger sheet URL', () => {
  const path = '/projects/p1/customize/triggers';

  test('opening from a closed sheet pushes ?id on Runs, so Back closes it', () => {
    expect(triggerSheetHref(path, 'type=cron', { slug: 'nightly' }, false)).toEqual({
      href: `${path}?type=cron&id=nightly`,
      mode: 'push',
    });
  });

  test('an unknown ?id on screen is not "open": the next open still pushes', () => {
    expect(triggerSheetHref(path, 'id=gone', { slug: 'nightly' }, false)).toEqual({
      href: `${path}?id=nightly`,
      mode: 'push',
    });
  });

  test('switching to another trigger replaces, and returns to Runs', () => {
    expect(triggerSheetHref(path, 'id=nightly&tab=settings', { slug: 'hook' }, true)).toEqual({
      href: `${path}?id=hook`,
      mode: 'replace',
    });
  });

  test('switching to Settings replaces and writes tab=settings', () => {
    expect(
      triggerSheetHref(path, 'id=nightly', { slug: 'nightly', tab: 'settings' }, true),
    ).toEqual({ href: `${path}?id=nightly&tab=settings`, mode: 'replace' });
    expect(
      triggerSheetHref(path, 'id=nightly&tab=settings', { slug: 'nightly', tab: 'runs' }, true),
    ).toEqual({ href: `${path}?id=nightly`, mode: 'replace' });
  });

  test('closing pushes, removes id, tab and the older ?t, and keeps the filter', () => {
    expect(
      triggerSheetHref(path, 'type=webhook&id=hook&tab=settings', { slug: null }, true),
    ).toEqual({ href: `${path}?type=webhook`, mode: 'push' });
    expect(triggerSheetHref(path, 't=hook', { slug: null }, true)).toEqual({
      href: path,
      mode: 'push',
    });
  });

  test('a deep link reads the id and the tab; Runs is the default', () => {
    expect(readTriggerSheet(new URLSearchParams('id=nightly&tab=settings'))).toEqual({
      slug: 'nightly',
      tab: 'settings',
    });
    expect(readTriggerSheet(new URLSearchParams('id=nightly'))).toEqual({
      slug: 'nightly',
      tab: 'runs',
    });
    expect(readTriggerSheet(new URLSearchParams('t=nightly&tab=bogus'))).toEqual({
      slug: 'nightly',
      tab: 'runs',
    });
    expect(readTriggerSheet(null)).toEqual({ slug: null, tab: 'runs' });
  });
});
