import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
const successToast = mock(() => {});
const errorToast = mock(() => {});
mock.module('@kortix/ui/toast', () => ({ successToast, errorToast }));
const { CopyBlock } = await import('./schedule-fields');

let renderer: ReactTestRenderer | undefined;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  mock.restore();
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

test('CopyBlock preserves its value, icon box, success state and 1600ms reset', async () => {
  const writeText = mock(async (_text: string) => {});
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  });
  await act(async () => {
    renderer = create(<CopyBlock value="synthetic webhook" label="Copy webhook" copiedLabel="Webhook copied" />);
  });
  if (!renderer) throw new Error('CopyBlock did not mount');
  const root = renderer.root;
  expect(root.findByType('code').props.children).toBe('synthetic webhook');
  expect(root.findByProps({ className: 'relative inline-flex size-3.5 items-center justify-center' })).toBeDefined();
  expect(root.findByType('button').props['aria-label']).toBe('Copy webhook');
  const timer = spyOn(globalThis, 'setTimeout');
  await act(async () => { await root.findByType('button').props.onClick(); });
  expect(writeText).toHaveBeenCalledWith('synthetic webhook');
  expect(root.findByType('button').props['aria-label']).toBe('Webhook copied');
  expect(root.findAllByProps({ className: 'text-kortix-green size-3.5' }).length).toBeGreaterThan(0);
  const reset = timer.mock.calls.find((call) => call[1] === 1600);
  if (!reset || typeof reset[0] !== 'function') throw new Error('Missing copy reset timer');
  await act(async () => { reset[0](); });
  expect(root.findByType('button').props['aria-label']).toBe('Copy webhook');
});

test('CopyBlock does not claim success when clipboard access fails', async () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error('Clipboard denied'); } } },
  });
  await act(async () => { renderer = create(<CopyBlock value="synthetic webhook" label="Copy webhook" />); });
  if (!renderer) throw new Error('CopyBlock did not mount');
  const root = renderer.root;
  await act(async () => { await root.findByType('button').props.onClick(); });
  expect(root.findByType('button').props['aria-label']).toBe('Copy webhook');
  expect(root.findAllByProps({ className: 'text-kortix-green size-3.5' })).toHaveLength(0);
});
