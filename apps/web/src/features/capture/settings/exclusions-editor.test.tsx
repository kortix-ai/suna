import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CapturePolicy } from '@kortix/sdk';
import { applyToPrivacy, fromPolicy, type ExclusionChange } from './exclusions-model';
import { ExclusionsEditor } from './exclusions-editor';
const window = new Window();
Object.assign(globalThis, {
  window, document: window.document, HTMLElement: window.HTMLElement,
  Node: window.Node, getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const container = document.createElement('div'); document.body.append(container);
let root = createRoot(container);
const changed = mock((_change: ExclusionChange) => {});
const privacy: CapturePolicy['privacy'] = {
  redact_pii: false, excluded_bundle_ids: ['com.tinyspeck.slackmacgap', 'slack.exe'],
  excluded_domains: [], exclusion_groups: [], exclude_private_browsing: false };
function Editor() {
  const [value, setValue] = useState(privacy);
  return <ExclusionsEditor org="Example" view={fromPolicy(value, (id) => ({ name: id, description: id }))}
    onChange={(change) => { changed(change); setValue((current) => applyToPrivacy(current, change)); }} />;
}
afterEach(async () => {
  await act(() => root.unmount()); root = createRoot(container);
  changed.mockClear(); });
function named(role: string, name: string) {
  const node = [...window.document.body.querySelectorAll(`[role="${role}"]`)].find((node) => node.getAttribute('aria-label') === name || node.textContent === name);
  if (!(node instanceof window.HTMLElement)) throw new Error(`missing ${role}: ${name}`);
  return node;
}
test('authorized editor toggles categories and removes all ids of a grouped app', async () => {
  await act(() => root.render(<Editor />));
  await act(() => named('checkbox', 'Password managers').click());
  expect(changed.mock.calls).toEqual([[{ kind: 'group', id: 'password_managers', on: true }]]);
  expect(named('checkbox', 'Password managers').getAttribute('aria-checked')).toBe('true');
  await act(() => named('checkbox', 'Slack').click());
  expect(changed.mock.calls.slice(1)).toEqual([
    [{ kind: 'app', id: 'com.tinyspeck.slackmacgap', on: false }], [{ kind: 'app', id: 'slack.exe', on: false }],
  ]);
  expect(window.document.body.querySelector('[aria-label="Slack"]')).toBeNull();
});
test('private browsing remains editable in the websites tab', async () => {
  await act(() => root.render(<Editor />));
  await act(() => named('tab', 'Websites').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 })));
  await act(() => named('checkbox', 'Private browsing').click());
  expect(changed.mock.calls).toEqual([[{ kind: 'private-browsing', on: true }]]);
  expect(named('checkbox', 'Private browsing').getAttribute('aria-checked')).toBe('true');
});
