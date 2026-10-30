import { afterEach, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let url = new URL('http://localhost/auth/reset-password?code=synthetic-code&next=home#done');
const replacements: string[] = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: { get href() { return url.href; } },
  },
});
mock.module('next/navigation', () => ({
  useSearchParams: () => url.searchParams,
  usePathname: () => url.pathname,
  useRouter: () => ({ replace(next: string) {
    replacements.push(next);
    url = new URL(next, url);
  } }),
  useParams: () => ({}),
}));
let result: { success: true } | { message: string } = { success: true };
mock.module('../actions', () => ({ resetPassword: async () => result }));
const NativeFormData = globalThis.FormData;
class PasswordFormData extends NativeFormData { constructor() { super(); } }
const { default: ResetPassword } = await import('./page');
afterEach(() => { globalThis.FormData = NativeFormData; replacements.length = 0; });

for (const succeeds of [true, false]) {
  test(`reset ${succeeds ? 'success removes the code and retains confirmation' : 'failure retains the code and allows retry'}`, async () => {
    globalThis.FormData = PasswordFormData;
    url = new URL('http://localhost/auth/reset-password?code=synthetic-code&next=home#done');
    result = succeeds ? { success: true } : { message: 'Synthetic failure' };
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => { tree = create(<ResetPassword />); });
    if (!tree) throw new Error('Page did not render');
    const root = tree;
    try {
      await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: {} }));
      expect(url.searchParams.get('code')).toBe(succeeds ? null : 'synthetic-code');
      expect(replacements).toHaveLength(succeeds ? 1 : 0);
      expect(url.searchParams.get('next')).toBe('home');
      expect(url.hash).toBe('#done');
      expect(JSON.stringify(root.toJSON())).toContain(succeeds ? 'Your password has been changed' : 'Synthetic failure');
      expect(JSON.stringify(root.toJSON())).not.toContain('Link expired');
    } finally { await act(async () => root.unmount()); }
  });
}

test('a missing code still offers a fresh link', async () => {
  url = new URL('http://localhost/auth/reset-password');
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => { tree = create(<ResetPassword />); });
  if (!tree) throw new Error('Page did not render');
  try { expect(JSON.stringify(tree.toJSON())).toContain('Link expired'); }
  finally { await act(async () => tree?.unmount()); }
});
