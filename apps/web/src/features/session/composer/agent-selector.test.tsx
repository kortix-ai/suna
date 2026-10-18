import type { Agent } from '@kortix/sdk/react';
import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const win = new Window();
const globals = globalThis as unknown as Record<string, unknown>;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.Event = win.Event;
globals.CustomEvent = win.CustomEvent;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) {
    globals[key] = (win as unknown as Record<string, unknown>)[key];
  }
}
// cmdk scrolls its active option; happy-dom has no layout to scroll.
win.HTMLElement.prototype.scrollIntoView = () => {};

// Import after installing the DOM so Radix mounts its real portals/effects.
const { AgentSelector } = await import('./agent-selector');
const { Popover, PopoverContent, PopoverTrigger } = await import('@/components/ui/popover');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const agents = [{ name: 'engineering', mode: 'primary' }] as Agent[];
let root: Root;
let host: HTMLElement;
let closed = 0;
let selections: Array<string | null> = [];

function Harness() {
  const [controlsOpen, setControlsOpen] = useState(false);
  const [overridden, setOverridden] = useState(true);
  return (
    <TooltipProvider>
      <button onClick={() => setControlsOpen(true)}>Open controls</button>
      <output data-testid="external-state">{String(controlsOpen)}</output>
      <AgentSelector
        agents={agents}
        selectedAgent="engineering"
        onSelect={(name) => selections.push(name)}
        controlsOpen={controlsOpen}
        onControlsClose={() => {
          closed++;
          setControlsOpen(false);
        }}
        footer={
          <>
            <Popover>
              <PopoverTrigger>Sandbox settings</PopoverTrigger>
              <PopoverContent>
                <button onClick={() => setOverridden(false)}>Use default sandbox</button>
              </PopoverContent>
            </Popover>
            <button onClick={() => setOverridden(false)}>Reset overrides</button>
            <output data-testid="override-state">
              {overridden ? 'Custom sandbox' : 'Agent default'}
            </output>
          </>
        }
      />
    </TooltipProvider>
  );
}

async function mount() {
  closed = 0;
  selections = [];
  host = win.document.createElement('div') as unknown as HTMLElement;
  win.document.body.append(host as never);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
}
function button(label: string) {
  const result = [...win.document.querySelectorAll('button')].find(
    (el) => el.textContent === label,
  );
  expect(result).toBeDefined();
  return result!;
}
async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
  });
}
function state(id: string) {
  return win.document.querySelector(`[data-testid="${id}"]`)?.textContent;
}
async function escape() {
  await act(async () => {
    win.document.activeElement?.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});

test('external controlsOpen opens the agent popover; Escape clears the host state and permits reopening', async () => {
  await mount();
  expect(win.document.querySelector('[role="dialog"]')).toBeNull();
  await click(button('Open controls') as unknown as Element);
  expect(win.document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button('Reset overrides')).toBeDefined();
  expect(state('external-state')).toBe('true');
  await escape();
  expect(closed).toBe(1);
  expect(state('external-state')).toBe('false');
  expect(win.document.querySelector('[role="dialog"]')).toBeNull();
  await click(button('Open controls') as unknown as Element);
  expect(button('Reset overrides')).toBeDefined();
});

test('nested footer popover is interactive without selecting an agent or closing the parent', async () => {
  await mount();
  await click(button('Open controls') as unknown as Element);
  await click(button('Sandbox settings') as unknown as Element);
  expect(win.document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  await click(button('Use default sandbox') as unknown as Element);
  expect(state('override-state')).toBe('Agent default');
  expect(selections).toEqual([]);
  await escape();
  expect(win.document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(closed).toBe(0);
  expect(state('external-state')).toBe('true');
  await escape();
  expect(state('external-state')).toBe('false');
});

test('selecting an agent from the externally opened popover also clears external state', async () => {
  await mount();
  await click(button('Open controls') as unknown as Element);
  const option = win.document.querySelector('[cmdk-item]');
  expect(option).not.toBeNull();
  await click(option as unknown as Element);
  expect(selections).toEqual(['engineering']);
  expect(closed).toBe(1);
  expect(state('external-state')).toBe('false');
  expect(win.document.querySelector('[role="dialog"]')).toBeNull();
});

test('footer reset changes the override without selecting an agent or closing the parent', async () => {
  await mount();
  await click(button('Open controls') as unknown as Element);
  expect(state('override-state')).toBe('Custom sandbox');
  await click(button('Reset overrides') as unknown as Element);
  expect(state('override-state')).toBe('Agent default');
  expect(selections).toEqual([]);
  expect(closed).toBe(0);
  expect(state('external-state')).toBe('true');
});
