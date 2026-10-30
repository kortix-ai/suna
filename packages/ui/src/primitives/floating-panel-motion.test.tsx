/**
 * Dropdown menus (root and submenu), selects, popovers and tooltips open and
 * close with no animation (COR-74, KRTX-189). Radix Presence keeps a closing
 * panel mounted until its `animate-out` fires `animationend`, so any enter or
 * exit animation makes every open AND every close wait on it.
 *
 * Each panel is rendered open on happy-dom (the not-found-title.test.tsx
 * pattern) and its RENDERED class list is checked, never the source text: a
 * panel that takes `MENU_PANEL` or `FLOATING_PANEL` (both carry
 * `FLOATING_PANEL_MOTION`) fails here as surely as one that spells
 * `animate-in` out.
 *
 * Out of scope on purpose: the context menu, the hover card and dialogs keep
 * their motion. Changing those is a product decision.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Container, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
// Bun has its own event classes. Radix's focus and dismiss layers create
// events by bare global name, and happy-dom dispatches only its own (the
// change-request-detail-dialog-controls.test.tsx setup).
for (const key of ['Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
  globals[key] = Reflect.get(win, key);
}

const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } =
  await import('./dropdown-menu');
const { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = await import('./select');
const { Popover, PopoverContent, PopoverTrigger } = await import('./popover');
const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = await import('./tooltip');
const { FLOATING_PANEL_MOTION } = await import('./menu-recipe');

/** Every enter/exit class: the shared motion recipe, plus the two keyframe switches. */
const MOTION_CLASSES = new Set([
  'animate-in',
  'animate-out',
  ...FLOATING_PANEL_MOTION.split(/\s+/).filter((token) => /animate|fade|zoom|slide/.test(token)),
]);

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  win.document.body.innerHTML = '';
});

/** Render `element` and return the class list of the element marked `testId`. */
async function renderedClasses(element: React.ReactElement, testId: string): Promise<string[]> {
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  await act(async () => {
    root.render(element);
  });
  const panel = win.document.body.querySelector(`[data-testid="${testId}"]`);
  // Not vacuous: the open panel is on the page.
  expect(panel).not.toBeNull();
  return (panel?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

const motionIn = (classes: string[]) => classes.filter((token) => MOTION_CLASSES.has(token) || /(^|:)animate-(in|out)$/.test(token));

describe('floating panels open and close with no animation', () => {
  test('the recipe still names the motion this guard looks for', () => {
    expect(MOTION_CLASSES.has('data-[state=open]:animate-in')).toBe(true);
    expect(MOTION_CLASSES.has('data-[state=closed]:animate-out')).toBe(true);
  });

  test('DropdownMenuContent', async () => {
    const classes = await renderedClasses(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent data-testid="panel">
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
      'panel',
    );
    expect(classes).toContain('bg-popover');
    expect(motionIn(classes)).toEqual([]);
  });

  test('DropdownMenuSubContent', async () => {
    const classes = await renderedClasses(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="subpanel">
              <DropdownMenuItem>Project</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
      'subpanel',
    );
    expect(classes).toContain('bg-popover');
    expect(motionIn(classes)).toEqual([]);
  });

  test('SelectContent', async () => {
    const classes = await renderedClasses(
      <Select open value="a">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent data-testid="panel">
          <SelectItem value="a">Alpha</SelectItem>
        </SelectContent>
      </Select>,
      'panel',
    );
    expect(classes).toContain('bg-popover');
    expect(motionIn(classes)).toEqual([]);
  });

  test('PopoverContent', async () => {
    const classes = await renderedClasses(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent data-testid="panel">Details</PopoverContent>
      </Popover>,
      'panel',
    );
    expect(classes).toContain('bg-popover');
    expect(motionIn(classes)).toEqual([]);
  });

  test('TooltipContent', async () => {
    const classes = await renderedClasses(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Hover</TooltipTrigger>
          <TooltipContent data-testid="panel">Hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
      'panel',
    );
    expect(classes).toContain('bg-foreground');
    expect(motionIn(classes)).toEqual([]);
  });
});
