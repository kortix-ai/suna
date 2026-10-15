import { afterEach, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import messages from '../../../../../../translations/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost:13000' } }, configurable: true,
});
mock.module('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(), usePathname: () => '/auth/forgot-password',
  useRouter: () => ({ push() {}, replace() {} }), useParams: () => ({}),
}));
mock.module('@/components/ui/toast', () => ({ errorToast: () => {} }));
const submits: { path: string; body: FormData }[] = [];
let succeed = false;
mock.module('@/lib/auth/submit-auth', () => ({
  submitAuthForm: async (path: string, body: FormData) => {
    submits.push({ path, body });
    return { ok: true, result: succeed ? { success: true } : { message: 'Synthetic send failure' } };
  },
}));
const NativeFormData = globalThis.FormData;
class EmailFormData extends NativeFormData {
  constructor() {
    super();
    this.set('email', 'synthetic@example.test');
  }
}
const { default: ForgotPassword } = await import('./page');
afterEach(() => { globalThis.FormData = NativeFormData; submits.length = 0; succeed = false; });

test('reset-link submit sends a request, keeps its failure visible, and retries to confirmation', async () => {
  globalThis.FormData = EmailFormData;
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => { tree = create(<NextIntlClientProvider locale="en" messages={messages}><ForgotPassword /></NextIntlClientProvider>); });
  if (!tree) throw new Error('Forgot-password page did not render');
  const root = tree;
  try {
    const submit = () => root.root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: {} });
    await act(async () => submit());
    expect(submits).toHaveLength(1);
    expect(submits[0]?.path).toBe('/api/auth/forgot-password');
    expect(submits[0]?.body.get('email')).toBe('synthetic@example.test');
    expect(submits[0]?.body.get('origin')).toBe('http://localhost:13000');
    expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
    expect(JSON.stringify(root.toJSON())).toContain('Synthetic send failure');
    expect(root.root.findByProps({ type: 'submit' }).props.disabled).toBe(false);
    succeed = true;
    await act(async () => submit());
    expect(submits).toHaveLength(2);
    expect(root.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(JSON.stringify(root.toJSON())).toContain('synthetic@example.test');
    expect(root.root.findAllByType('form')).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});
