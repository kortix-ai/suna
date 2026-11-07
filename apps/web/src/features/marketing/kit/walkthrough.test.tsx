import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/*
 * The walkthrough stepper of the seven solution-page heroes, pinned through
 * each shipped hero's DOM: it advances every step interval, never under
 * reduced motion, holds after a click or an arrow key, and the arrows wrap at
 * both ends and move focus with the selection.
 */

const win = new Window();
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  navigator: { value: win.navigator, configurable: true },
  KeyboardEvent: { value: win.KeyboardEvent, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});

// motion reads the reduced-motion preference once per process; the stub lets
// each test pick it.
let reducedMotion = false;
const motion = await import('motion/react');
mock.module('motion/react', () => ({ ...motion, useReducedMotion: () => reducedMotion }));

const [compliance, enterprise, framework, multiplayer, security, selfHosted, sovereign] =
  await Promise.all([
    import('../compliance/compliance-hero'),
    import('../enterprise/enterprise-hero'),
    import('../framework/framework-hero'),
    import('../multiplayer/multiplayer-hero'),
    import('../security-page/security-hero'),
    import('../self-hosted/self-hosted-hero'),
    import('../sovereign/sovereign-hero'),
  ]);

const HEROES: { Hero: ComponentType; idPrefix: string; stepMs: number }[] = [
  { Hero: compliance.ComplianceHero, idPrefix: 'compliance-walk', stepMs: 4000 },
  { Hero: enterprise.EnterpriseHero, idPrefix: 'enterprise-walk', stepMs: 4000 },
  { Hero: framework.FrameworkHero, idPrefix: 'framework-walk', stepMs: 4500 },
  { Hero: multiplayer.MultiplayerHero, idPrefix: 'multiplayer-walk', stepMs: 4500 },
  { Hero: security.SecurityHero, idPrefix: 'security-walk', stepMs: 3500 },
  { Hero: selfHosted.SelfHostedHero, idPrefix: 'selfhost-walk', stepMs: 4000 },
  { Hero: sovereign.SovereignHero, idPrefix: 'sovereign-walk', stepMs: 4000 },
];

let root: Root | null = null;

beforeEach(() => {
  reducedMotion = false;
  jest.useFakeTimers();
});

afterEach(() => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  root = null;
  jest.useRealTimers();
  document.body.innerHTML = '';
});

function mount(Hero: ComponentType) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
    root.render(<Hero />);
  });
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const tablist = document.querySelector('[role="tablist"]');
  if (!tablist || tabs.length < 2) throw new Error('hero renders no walkthrough tablist');
  return { tabs, tablist };
}

const selectedIndex = (tabs: readonly Element[]) =>
  tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');

const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));

function press(target: Element, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

describe.each(HEROES)('$idPrefix walkthrough', ({ Hero, idPrefix, stepMs }) => {
  test('renders a labelled tablist of numbered tabs that control one panel', () => {
    const { tabs, tablist } = mount(Hero);
    expect(tablist.getAttribute('aria-label')).toBeTruthy();
    expect(selectedIndex(tabs)).toBe(0);
    tabs.forEach((tab, i) => {
      expect(tab.getAttribute('id')).toStartWith(`${idPrefix}-`);
      expect(tab.getAttribute('aria-controls')).toBe(`${idPrefix}-panel`);
      expect(tab.getAttribute('tabindex')).toBe(i === 0 ? '0' : '-1');
      expect(tab.querySelector('span')?.textContent).toBe(String(i + 1));
    });
    const panel = document.getElementById(`${idPrefix}-panel`);
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(tabs[0].getAttribute('id'));
  });

  test('advances one step per interval and wraps after the last step', () => {
    const { tabs } = mount(Hero);
    advance(stepMs - 1);
    expect(selectedIndex(tabs)).toBe(0);
    advance(1);
    expect(selectedIndex(tabs)).toBe(1);
    expect(tabs[1].getAttribute('tabindex')).toBe('0');
    expect(document.getElementById(`${idPrefix}-panel`)?.getAttribute('aria-labelledby')).toBe(
      tabs[1].getAttribute('id'),
    );
    advance(stepMs * (tabs.length - 1));
    expect(selectedIndex(tabs)).toBe(0);
  });

  test('never advances under reduced motion', () => {
    reducedMotion = true;
    const { tabs } = mount(Hero);
    advance(stepMs * (tabs.length + 1));
    expect(selectedIndex(tabs)).toBe(0);
  });

  test('a click selects the step and holds it', () => {
    const { tabs } = mount(Hero);
    const last = tabs.length - 1;
    act(() => (tabs[last] as HTMLElement).click());
    expect(selectedIndex(tabs)).toBe(last);
    advance(stepMs * (tabs.length + 1));
    expect(selectedIndex(tabs)).toBe(last);
  });

  test('arrow keys wrap at both ends, move focus and hold the step', () => {
    const { tabs, tablist } = mount(Hero);
    const last = tabs.length - 1;

    expect(press(tabs[0], 'ArrowLeft')).toBe(true);
    expect(selectedIndex(tabs)).toBe(last);
    expect(document.activeElement?.id).toBe(tabs[last].id);

    expect(press(tabs[last], 'ArrowRight')).toBe(true);
    expect(selectedIndex(tabs)).toBe(0);
    expect(document.activeElement?.id).toBe(tabs[0].id);

    expect(press(tabs[0], 'ArrowDown')).toBe(true);
    expect(selectedIndex(tabs)).toBe(1);
    expect(press(tabs[1], 'ArrowUp')).toBe(true);
    expect(selectedIndex(tabs)).toBe(0);

    advance(stepMs * (tabs.length + 1));
    expect(selectedIndex(tabs)).toBe(0);

    expect(press(tablist, 'Enter')).toBe(false);
    expect(selectedIndex(tabs)).toBe(0);
  });

  test('another key neither selects nor holds the step', () => {
    const { tabs } = mount(Hero);
    expect(press(tabs[0], 'Home')).toBe(false);
    advance(stepMs);
    expect(selectedIndex(tabs)).toBe(1);
  });
});
