import { afterEach, expect, mock, test } from 'bun:test';
import { createElement, type PropsWithChildren } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const errorToast = mock(() => {});
const passthrough = ({ children }: PropsWithChildren) => children;
mock.module('@/i18n/use-translations', () => ({
  useLocale: () => 'en',
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
mock.module('@calcom/embed-react', () => ({
  default: () => createElement('div', { 'data-cal': true }),
  getCalApi: async () => () => {},
}));
mock.module('@/components/ui/modal', () => ({
  Modal: passthrough,
  ModalBody: passthrough,
  ModalClose: passthrough,
  ModalContent: passthrough,
  ModalDescription: passthrough,
  ModalFooter: passthrough,
  ModalHeader: passthrough,
  ModalTitle: passthrough,
}));
mock.module('@/components/ui/select', () => ({
  Select: (props: {
    value?: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) =>
    createElement('select', { value: props.value, onChange: props.onValueChange }, props.children),
  SelectContent: passthrough,
  SelectItem: passthrough,
  SelectTrigger: passthrough,
  SelectValue: () => null,
}));
mock.module('@/components/ui/toast', () => ({ errorToast }));

const { DemoQualifierModal } = await import('./demo-qualifier-modal');
const originalFetch = globalThis.fetch;
let view: ReactTestRenderer | undefined;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  errorToast.mockClear();
  await act(async () => view?.unmount());
  view = undefined;
});

async function form(size: string) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <DemoQualifierModal
        open
        onOpenChange={() => {}}
        calLink="synthetic/demo"
        calNamespace="synthetic"
        defaultName="Demo visitor"
        defaultEmail="agent@kortix.ai"
      />,
    );
  });
  if (!renderer) throw new Error('Modal did not render');
  view = renderer;
  const root = renderer.root;
  await act(async () => {
    root
      .findByProps({ id: 'dq-company' })
      .props.onChange({ target: { value: 'Synthetic company' } });
    root.findByType('select').props.onChange(size);
  });
  return renderer;
}

for (const size of ['1-10', '11-50']) {
  for (const status of [400, 413, 429, 500]) {
    test(`${size}: HTTP ${status} keeps the form and permits retry`, async () => {
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ) => new Response(null, { status })) as typeof fetch;
      const renderer = await form(size);
      await act(async () =>
        renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }),
      );
      expect(renderer.root.findAllByType('form')).toHaveLength(1);
      expect(errorToast).toHaveBeenCalledTimes(1);
      expect(renderer.root.findByProps({ type: 'submit' }).props.disabled).toBe(false);
      expect(renderer.root.findByProps({ id: 'dq-company' }).props.value).toBe('Synthetic company');
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ) => new Response(null, { status: 201 })) as typeof fetch;
      await act(async () =>
        renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }),
      );
      expect(renderer.root.findAllByType('form')).toHaveLength(0);
      expect(renderer.root.findAllByProps({ 'data-cal': true })).toHaveLength(
        size === '11-50' ? 1 : 0,
      );
      expect(errorToast).toHaveBeenCalledTimes(1);
    });
  }
  test(`${size}: a network failure keeps the form`, async () => {
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new TypeError('Network unavailable');
    }) as typeof fetch;
    const renderer = await form(size);
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(renderer.root.findAllByType('form')).toHaveLength(1);
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ type: 'submit' }).props.disabled).toBe(false);
  });
  for (const status of [200, 204]) {
    test(`${size}: HTTP ${status} advances without an error toast`, async () => {
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ) => new Response(null, { status })) as typeof fetch;
      const renderer = await form(size);
      await act(async () =>
        renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }),
      );
      expect(renderer.root.findAllByType('form')).toHaveLength(0);
      expect(renderer.root.findAllByProps({ 'data-cal': true })).toHaveLength(
        size === '11-50' ? 1 : 0,
      );
      expect(errorToast).not.toHaveBeenCalled();
    });
  }
}
