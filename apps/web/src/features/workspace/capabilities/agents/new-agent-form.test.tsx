import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';


const win = new Window();
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
Object.defineProperty(globalThis, 'document', { value: win.document, configurable: true });
Object.defineProperty(globalThis, 'Event', { value: win.Event, configurable: true });

const { createRoot } = await import('react-dom/client');
const { NewAgentForm } = await import('./new-agent-form');

test('manual setup submits instructions and refuses an existing agent name', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const submissions: unknown[] = [];
  await act(async () => root.render(<NewAgentForm existingNames={['existing-agent']} pending={false} onCancel={() => {}} onSubmit={(name, block) => submissions.push({ name, block })} />));
  const name = host.querySelector('input');
  const instructions = host.querySelector('textarea');
  const form = host.querySelector('form');
  if (!name || !instructions || !form) throw new Error('Manual setup must expose a creation form');
  const change = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
      setter?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  await change(name, 'existing-agent');
  await change(instructions, 'Reply pong.');
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(submissions).toEqual([]);
  expect(host.textContent).toContain('already exists');
  await change(name, 'new-agent');
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(submissions).toEqual([{ name: 'new-agent', block: { behavior: { mode: 'primary', prompt: 'Reply pong.' } } }]);
  await act(async () => root.unmount());
  host.remove();
});
