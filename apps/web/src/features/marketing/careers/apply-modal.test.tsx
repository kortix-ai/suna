import { afterEach, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const toast = mock(() => {});
mock.module('@/components/ui/toast', () => ({ errorToast: toast }));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
// Overlay portals need a browser. Keep the real form and its state transitions.
const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
mock.module('@/components/ui/modal', () => ({
  Modal: container, ModalContent: container, ModalHeader: container,
  ModalTitle: container, ModalDescription: container, ModalBody: container, ModalFooter: container,
}));
mock.module('@/components/ui/marketing/select', () => ({
  Select: container, SelectContent: container, SelectItem: container,
  SelectTrigger: container, SelectValue: container,
}));
const { ApplyModal } = await import('./apply-modal');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; toast.mockClear(); });

for (const outcome of [200, 204, 400, 500, 'network'] as const) {
  test(`application ${outcome}: receipt only for accepted responses, cleanup and payload preserved`, async () => {
    let finish: (response: Response) => void = () => { throw new Error('request not started'); };
    let reject: (error: Error) => void = () => { throw new Error('request not started'); };
    const request = mock((_url: string | URL | Request, _init?: RequestInit) =>
      new Promise<Response>((resolve, fail) => { finish = resolve; reject = fail; }));
    globalThis.fetch = Object.assign(request, { preconnect: originalFetch.preconnect });
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { renderer = create(createElement(ApplyModal, { open: true, onOpenChange: () => {} })); });
      if (!renderer) throw new Error('modal not rendered');
      const root = renderer.root;
      for (const [id, value] of [
        ['apply-name', ' Synthetic Applicant '], ['apply-email', 'synthetic@example.test'],
        ['apply-owned', ' Built a synthetic project '], ['apply-link', 'https://example.test/portfolio'],
      ]) {
        await act(async () => root.findByProps({ id }).props.onChange({ target: { value } }));
      }
      // Select's public callback is the input boundary; no submission logic is mocked.
      const select = root.findAll((node) => typeof node.props.onValueChange === 'function')[0];
      if (!select) throw new Error('opening select missing');
      await act(async () => select.props.onValueChange('Product / Eng'));
      await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }));
      expect(root.findByProps({ type: 'submit' }).props.disabled).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]).toEqual(['/api/demo-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Synthetic Applicant', email: 'synthetic@example.test',
          company_name: 'Careers — Product / Eng',
          goal: 'Opening: Product / Eng\nOwned: Built a synthetic project\nLink: https://example.test/portfolio',
          opening: 'Product / Eng', owned: 'Built a synthetic project', link: 'https://example.test/portfolio',
          qualified: false, source: 'careers-application' }),
      }]);
      await act(async () => {
        if (outcome === 'network') reject(new Error('offline'));
        else finish(new Response(null, { status: outcome }));
      });
      const accepted = typeof outcome === 'number' && outcome < 300;
      expect(root.findAllByType('form')).toHaveLength(accepted ? 0 : 1);
      expect(JSON.stringify(renderer.toJSON()).includes('Application received.')).toBe(accepted);
      expect(toast.mock.calls.length).toBe(accepted ? 0 : 1);
      expect(root.findAllByType('p').some((node) => node.children.includes('textc3bf78fdd3b9'))).toBe(!accepted);
      if (!accepted) {
        expect(root.findByProps({ type: 'submit' }).props.disabled).toBe(false);
        expect(root.findByProps({ id: 'apply-name' }).props.value).toBe(' Synthetic Applicant ');
        expect(root.findByProps({ id: 'apply-owned' }).props.value).toBe(' Built a synthetic project ');
        expect(root.findByProps({ id: 'apply-email' }).props.value).toBe('synthetic@example.test');
        expect(root.findByProps({ id: 'apply-link' }).props.value).toBe('https://example.test/portfolio');
        expect(root.findAll((node) => typeof node.props.onValueChange === 'function')[0]?.props.value).toBe('Product / Eng');
      }
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });
}
