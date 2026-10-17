import { readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';
import { TriggerToolbarMenu } from './schedule-view';
import { readTriggerSheet, triggerSheetHref } from './schedule/trigger-filter';

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

const menuProps = { paused: false, isPending: false, activeCount: 4, onToggle: () => {} };

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

  test('pause-all lives in the toolbar ⋯ menu, not a gear or a list banner', () => {
    expect(shellHeader).toContain('<TriggerActivationMenu projectId={projectId} />');
    expect(code).not.toContain('GearSixIcon');
    expect(code).not.toContain('PopoverTrigger');
    expect(shellChildren).not.toContain('TriggerActivationMenu');
    expect(shellChildren).not.toContain('Pause all triggers');
  });

  test('the empty state has no brand mark and offers the create action', () => {
    expect(code).not.toContain('PixelKortixMark');
    expect(shellChildren).toContain('icon={LightningIcon}');
    expect(shellChildren).toContain('onClick={() => openCreate()}');
  });

  // Who sees the gear is rendered per role in `trigger-activation-menu.test.tsx`.

  // The paused STATE is not the paused CONTROL: a project that runs nothing on
  // its own stays announced at the top of the list.
  test('the paused banner stays prominent in the content column', () => {
    expect(shellChildren).toContain('Everything is paused');
    expect(shellChildren).toContain('{paused && showContent &&');
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
