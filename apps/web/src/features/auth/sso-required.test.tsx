import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

/**
 * The account requires single sign-on: the API answers `sso_required` and the
 * SDK dispatches `kortix:sso-required`. The app stays rendered behind a dialog
 * that offers to sign out, so the person can sign in again through the IdP.
 */

let signOuts = 0;
mock.module('@/lib/auth/perform-sign-out', () => ({
  performSignOut: async () => {
    signOuts += 1;
  },
}));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => (key: string) => key,
}));
const host = (tag: string) =>
  function Host({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) {
    return createElement(tag, props, children);
  };
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? createElement('div', { 'data-dialog': 'open' }, children) : null,
  DialogContent: host('section'),
  DialogDescription: host('p'),
  DialogFooter: host('footer'),
  DialogHeader: host('header'),
  DialogTitle: host('h2'),
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) =>
    createElement('button', props, children),
}));
mock.module('@/components/ui/loading', () => ({ default: () => createElement('span', null, 'loading') }));

const { SsoRequiredProvider } = await import('./sso-required');

const originalWindow = globalThis.window;
beforeEach(() => {
  signOuts = 0;
  globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
});
afterEach(() => {
  globalThis.window = originalWindow;
});

async function mount(): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(createElement(SsoRequiredProvider, null, createElement('main', null, 'APP CONTENT')));
  });
  return root;
}
const text = (root: ReactTestRenderer) => JSON.stringify(root.toJSON());
const button = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((node) => node.type === 'button' && JSON.stringify(node.props.children).includes(label))[0];

describe('SsoRequiredProvider', () => {
  test('stays closed until kortix:sso-required, then asks to sign in with SSO over the app', async () => {
    const root = await mount();
    expect(text(root)).toContain('APP CONTENT');
    expect(text(root)).not.toContain('data-dialog');

    await act(async () => {
      window.dispatchEvent(new CustomEvent('kortix:sso-required'));
    });

    expect(text(root)).toContain('APP CONTENT');
    expect(text(root)).toContain('title');
    expect(text(root)).toContain('signOut');
  });

  test('"Sign out and use SSO" signs out; "Not now" closes without signing out', async () => {
    const root = await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kortix:sso-required'));
    });
    await act(async () => {
      (button(root, 'notNow')?.props.onClick as () => void)();
    });
    expect(text(root)).not.toContain('signOut');
    expect(signOuts).toBe(0);

    await act(async () => {
      window.dispatchEvent(new CustomEvent('kortix:sso-required'));
    });
    await act(async () => {
      (button(root, 'signOut')?.props.onClick as () => void)();
    });
    expect(signOuts).toBe(1);
  });
});
