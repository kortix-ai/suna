/**
 * THE principal row (`PrincipalRow`), through a real click: the members card's
 * row and a Details panel row open that person's or agent's Profile, and the
 * card's row closes the card it sits in. Enter on the focused row does the
 * same (a native button).
 */
import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const win = new Window({ width: 1280, height: 800 });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.HTMLElement = win.HTMLElement;
globals.Element = win.Element;
globals.Node = win.Node;
globals.getComputedStyle = win.getComputedStyle.bind(win);

const { PrincipalRow, ProfileContext } = await import('./principal-card');
type Principal = Parameters<typeof PrincipalRow>[0]['principal'];

async function renderRow(row: React.ReactNode, onProfile: (p: Principal) => void) {
  const host = win.document.createElement('ul');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(<ProfileContext.Provider value={onProfile}>{row}</ProfileContext.Provider>);
  });
  return { host, root };
}

describe('a principal row', () => {
  test("the members card's person row opens their Profile and closes the card", async () => {
    const opened: Principal[] = [];
    let closed = 0;
    const { host, root } = await renderRow(
      <PrincipalRow
        projectId="p1"
        principal={{ kind: 'person', userId: 'u-ana', name: 'Ana Lima' }}
        avatar={<span />}
        name="Ana Lima"
        onOpened={() => (closed += 1)}
      />,
      (p) => opened.push(p),
    );
    const button = host.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toContain('Ana Lima');
    await act(async () => {
      (button as unknown as { click: () => void }).click();
    });
    expect(opened).toEqual([{ kind: 'person', userId: 'u-ana', name: 'Ana Lima' }]);
    expect(closed).toBe(1);
    await act(async () => root.unmount());
  });

  test("a Details agent row opens the agent's Profile", async () => {
    const opened: Principal[] = [];
    const { host, root } = await renderRow(
      <PrincipalRow projectId="p1" principal={{ kind: 'agent', name: 'worker' }} avatar={<span />} name="Worker" tag="Default" />,
      (p) => opened.push(p),
    );
    const button = host.querySelector('button')!;
    expect(button.textContent).toContain('Worker');
    expect(button.textContent).toContain('Default');
    await act(async () => {
      (button as unknown as { click: () => void }).click();
    });
    expect(opened).toEqual([{ kind: 'agent', name: 'worker' }]);
    await act(async () => root.unmount());
  });
});
