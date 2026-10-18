import { afterEach, expect, jest, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const messages: string[] = [];
const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => translate }));
mock.module('@/components/ui/toast', () => ({
  successToast: (message: string) => messages.push(message),
  errorToast: (message: string) => messages.push(message),
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement('button', props, children),
}));
mock.module('@/components/ui/label', () => ({ Label: ({ children }: { children?: ReactNode }) => children }));
const { SessionEmbedSection } = await import('./session-embed-section');
let renderer: ReactTestRenderer | undefined;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

async function mount(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://kortix.com' } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText } } });
  await act(async () => { renderer = create(createElement(SessionEmbedSection, { projectId: 'synthetic-project', sessionId: 'synthetic-session' })); });
  if (!renderer) throw new Error('Section did not mount');
  return renderer;
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  messages.length = 0;
  for (const [key, descriptor] of [['window', originalWindow], ['navigator', originalNavigator]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('a completed clipboard write after unmount does not announce success', async () => {
  let finish = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const page = await mount(() => pending);
  let copying: Promise<void> = Promise.resolve();
  await act(async () => { copying = page.root.findByType('button').props.onClick(); });
  await act(async () => page.unmount());
  await act(async () => { finish(); await copying; });
  expect(messages).toEqual([]);
});

test('copy feedback expires two seconds after the latest successful copy', async () => {
  jest.useFakeTimers();
  const writes: string[] = [];
  const page = await mount(async (text) => { writes.push(text); });
  await act(async () => { await page.root.findByType('button').props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(1000); });
  await act(async () => { await page.root.findByType('button').props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(JSON.stringify(page.toJSON())).toContain('text-kortix-green');
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(JSON.stringify(page.toJSON())).not.toContain('text-kortix-green');
  expect(writes).toHaveLength(2);
  expect(writes[0]).toContain('/projects/synthetic-project/sessions/synthetic-session');
});
