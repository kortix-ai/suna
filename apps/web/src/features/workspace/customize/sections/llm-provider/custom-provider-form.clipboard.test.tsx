import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const successToast = mock(() => {});
const errorToast = mock(() => {});
const upsertProjectSecret = mock(async () => {});
mock.module('@/components/ui/toast', () => ({ successToast, errorToast }));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => ({ raw: (key: string) => `localized:${key}` }),
}));
mock.module('@kortix/sdk', () => ({ upsertProjectSecret }));
mock.module('@kortix/sdk/react', () => ({
  qk: { project: { secrets: (id: string) => ['secrets', id] } },
  refreshProjectProviderState: mock(() => {}),
}));
mock.module('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  m: { span: ({ children }: { children: ReactNode }) => <span>{children}</span> },
}));
const { CustomProviderForm } = await import('./custom-provider-form');
const expectedSnippet = JSON.stringify(
  {
    provider: {
      example: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Example',
        options: { baseURL: 'https://api.example.com/v1', apiKey: '{env:CUSTOM_EXAMPLE_API_KEY}' },
        models: { 'model-one': { id: 'model-one', name: 'Model One', family: 'example' } },
      },
    },
  },
  null,
  2,
);
let renderer: ReactTestRenderer;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(async () => {
  await act(async () => renderer?.unmount());
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
  mock.restore();
  successToast.mockClear();
  errorToast.mockClear();
  upsertProjectSecret.mockClear();
});
async function submit(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  });
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <CustomProviderForm projectId="test-project" onDone={() => {}} />
      </QueryClientProvider>,
    );
  });
  for (const [id, value] of Object.entries({
    'custom-provider-id': 'example',
    'custom-display-name': 'Example',
    'custom-base-url': 'https://api.example.com/v1',
    'custom-api-key': 'synthetic-key',
    'custom-model-id': 'model-one',
    'custom-model-name': 'Model One',
  })) {
    await act(async () => renderer.root.findByProps({ id }).props.onChange({ target: { value } }));
  }
  await act(async () => {
    renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(upsertProjectSecret).toHaveBeenCalledWith('test-project', {
    name: 'CUSTOM_EXAMPLE_API_KEY',
    value: 'synthetic-key',
    strategy: 'broker',
    consumer: 'llm_gateway',
  });
  expect(renderer.root.findByType('pre').props.children).toBe(expectedSnippet);
}
const copyButton = () => renderer.root.findByProps({ 'aria-label': 'localized:text968d0a9d24a6' });
describe('CustomProviderForm clipboard characterization', () => {
  test('copies the exact saved snippet, localizes success, and resets at 1500ms', async () => {
    const writeText = mock(async (_text: string) => {});
    await submit(writeText);
    const timer = spyOn(globalThis, 'setTimeout');
    await act(async () => {
      await copyButton().props.onClick();
    });
    expect(writeText).toHaveBeenCalledWith(expectedSnippet);
    expect(successToast).toHaveBeenCalledWith('localized:texte957fd04449d');
    expect(errorToast).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ 'aria-label': 'Copied' })).toBeDefined();
    const reset = timer.mock.calls.find((call) => call[1] === 1500);
    expect(reset).toBeDefined();
    if (!reset || typeof reset[0] !== 'function') throw new Error('Missing copy reset timer');
    await act(async () => {
      reset[0]();
    });
    expect(copyButton()).toBeDefined();
  });
  test('localizes rejection and leaves the button uncopied', async () => {
    const writeText = mock(async (_text: string) => {
      throw new Error('Clipboard denied');
    });
    await submit(writeText);
    await act(async () => {
      await copyButton().props.onClick();
    });
    expect(writeText).toHaveBeenCalledWith(expectedSnippet);
    expect(errorToast).toHaveBeenCalledWith('localized:text94f69e8f103e');
    expect(successToast).not.toHaveBeenCalled();
    expect(copyButton()).toBeDefined();
    expect(renderer.root.findAllByProps({ 'aria-label': 'Copied' })).toHaveLength(0);
  });
});
