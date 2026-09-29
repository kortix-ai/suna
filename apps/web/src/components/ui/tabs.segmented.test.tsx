import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabs, TabsList, TabsListCompact, TabsTrigger, TabsTriggerCompact } from './tabs';

const render = (list: ReactNode) =>
  renderToStaticMarkup(<Tabs defaultValue="managed">{list}</Tabs>);

/** The className string of the trigger for `value`. */
const triggerClasses = (out: string, label: string): string =>
  out.match(new RegExp(`<button[^>]*class="([^"]*)"[^>]*>${label}</button>`))?.[1] ?? '';

const TRACK = ['bg-muted', 'rounded-md', 'p-0.5'];
const CHIP = [
  'data-[state=active]:bg-popover',
  'data-[state=active]:ring-1',
  'data-[state=active]:ring-border',
  'data-[state=active]:shadow-xs',
];

describe('segmented tabs', () => {
  test('TabsList variant="segmented" draws the recessed track', () => {
    const out = render(
      <TabsList variant="segmented">
        <TabsTrigger value="managed">Kortix managed</TabsTrigger>
        <TabsTrigger value="github">GitHub</TabsTrigger>
      </TabsList>,
    );
    for (const cls of TRACK) expect(out).toContain(cls);
  });

  test('triggers fill the track with the concentric chip radius', () => {
    const out = render(
      <TabsList variant="segmented">
        <TabsTrigger value="managed">Kortix managed</TabsTrigger>
        <TabsTrigger value="github">GitHub</TabsTrigger>
      </TabsList>,
    );
    const cls = triggerClasses(out, 'GitHub');
    expect(cls).toContain('h-full');
    expect(cls).toContain('rounded-sm');
    expect(cls).toContain('data-[state=inactive]:text-muted-foreground');
  });

  test('type="segmented" is the same control as variant="segmented"', () => {
    const list = (props: { type?: 'segmented'; variant?: 'segmented' }) =>
      render(
        <TabsList {...props}>
          <TabsTrigger value="managed">Kortix managed</TabsTrigger>
        </TabsList>,
      ).replace(/radix-[^"]*/g, '');
    expect(list({ type: 'segmented' })).toBe(list({ variant: 'segmented' }));
  });

  test('with animate="none" the active trigger paints the chip itself', () => {
    const out = render(
      <TabsList variant="segmented" animate="none">
        <TabsTrigger value="managed">Kortix managed</TabsTrigger>
      </TabsList>,
    );
    const cls = triggerClasses(out, 'Kortix managed');
    for (const chip of CHIP) expect(cls).toContain(chip);
    expect(cls).not.toContain('data-[state=active]:bg-input');
  });

  test('TabsTrigger variant="segmented" matches a plain trigger in the default list', () => {
    const list = (variant?: 'segmented') =>
      render(
        <TabsList>
          <TabsTrigger value="managed" variant={variant}>
            Kortix managed
          </TabsTrigger>
        </TabsList>,
      )
        .replace(/radix-[^"]*/g, '')
        .replace(/ data-variant="[a-z]+"/, '');
    expect(list('segmented')).toBe(list());
  });

  test('the default list IS the segmented control', () => {
    const list = (props: { variant?: 'segmented' }) =>
      render(
        <TabsList {...props}>
          <TabsTrigger value="managed">Kortix managed</TabsTrigger>
        </TabsList>,
      ).replace(/radix-[^"]*/g, '');
    expect(list({})).toBe(list({ variant: 'segmented' }));
    for (const cls of TRACK) expect(list({})).toContain(cls);
  });

  test('underline and vertical lists are not segmented', () => {
    const underline = render(
      <TabsList type="underline">
        <TabsTrigger value="managed">Kortix managed</TabsTrigger>
      </TabsList>,
    );
    expect(underline).not.toContain('bg-muted');
    const vertical = render(
      <TabsList orientation="vertical">
        <TabsTrigger value="managed">Kortix managed</TabsTrigger>
      </TabsList>,
    );
    expect(vertical).not.toContain('bg-muted');
    expect(triggerClasses(vertical, 'Kortix managed')).not.toContain('rounded-sm');
  });

  test('an explicit outline trigger keeps its bordered chip', () => {
    const out = render(
      <TabsList animate="none">
        <TabsTrigger value="managed" variant="outline">
          Kortix managed
        </TabsTrigger>
      </TabsList>,
    );
    const cls = triggerClasses(out, 'Kortix managed');
    expect(cls).toContain('data-[state=active]:border-border');
    expect(cls).not.toContain('data-[state=active]:bg-popover');
  });

  test('the compact list defaults to the segmented control too', () => {
    const out = render(
      <TabsListCompact animate="none">
        <TabsTriggerCompact value="managed">Kortix managed</TabsTriggerCompact>
      </TabsListCompact>,
    );
    for (const cls of TRACK) expect(out).toContain(cls);
    const cls = triggerClasses(out, 'Kortix managed');
    expect(cls).toContain('h-full');
    expect(cls).toContain('rounded-sm');
    for (const chip of CHIP) expect(cls).toContain(chip);
  });
});
