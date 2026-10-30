import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { CopyButton } from './copy-button';

const originalGlobals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
const window = new Window();
Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true });

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
afterAll(() => {
  for (const { key, descriptor } of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.happyDOM.abort();
});
let renderer: ReactTestRenderer | undefined;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

test('announces success only after the command reaches the clipboard', async () => {
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    },
  });
  await act(async () => {
    renderer = create(<CopyButton code="echo synthetic" />);
  });
  if (!renderer) throw new Error('CopyButton did not mount');
  const root = renderer.root;
  expect(root.findByProps({ role: 'status' }).props.children).toBe('');
  await act(async () => {
    await root.findByType('button').props.onClick();
  });
  expect(writes).toEqual(['echo synthetic']);
  expect(root.findByType('button').props['aria-label']).toBe('Copied');
  expect(root.findByProps({ role: 'status' }).props.children).toBe('Copied');
  expect(root.findByProps({ role: 'status' }).props['aria-live']).toBe('polite');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2100));
  });
  expect(root.findByType('button').props['aria-label']).toBe('Copy code');
  expect(root.findByProps({ role: 'status' }).props.children).toBe('');
  await act(async () => {
    await root.findByType('button').props.onClick();
  });
  expect(writes).toEqual(['echo synthetic', 'echo synthetic']);
  expect(root.findByProps({ role: 'status' }).props.children).toBe('Copied');
});

test('announces a rejected clipboard write without claiming success', async () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {
          throw new Error('Clipboard denied');
        },
      },
    },
  });
  await act(async () => {
    renderer = create(<CopyButton code="echo synthetic" />);
  });
  if (!renderer) throw new Error('CopyButton did not mount');
  const root = renderer.root;
  await act(async () => {
    await root.findByType('button').props.onClick();
  });
  expect(root.findByType('button').props['aria-label']).toBe('Copy code');
  expect(root.findByProps({ role: 'status' }).props.children).toBe(
    'Could not copy to the clipboard',
  );
});
