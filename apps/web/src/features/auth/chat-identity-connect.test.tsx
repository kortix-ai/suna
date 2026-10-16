import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// The consent screen links a chat account to the signed-in Kortix user. It must
// name that chat account before Connect is usable: the preview is fetched after
// mount, so the first render shows the pending row and a disabled Connect.

// One object for every render, as the real provider does: the preview effect
// depends on `user`, so a new object per render re-runs it without end.
const auth = { user: { email: 'member@example.com' }, isLoading: false };
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => auth }));
const navigation = await import('next/navigation');
mock.module('next/navigation', () => ({
  ...navigation,
  useRouter: () => ({ replace: () => {}, push: () => {}, prefetch: () => {} }),
}));

const { ChatIdentityConnect } = await import('./chat-identity-connect');

function render(preview: () => Promise<never>) {
  return renderToStaticMarkup(
    <ChatIdentityConnect
      service="Slack"
      token="token.sig"
      loginPath="/slack/login/token.sig"
      bind={async () => ({ resumed: false, hasAccess: true })}
      preview={preview}
      missingLinkMessage="missing"
      disconnectNote="note"
    />,
  );
}

describe('ChatIdentityConnect', () => {
  test('shows a row for the chat account being linked', () => {
    const html = render(() => new Promise<never>(() => {}));

    expect(html).toContain('Slack account');
    expect(html).toContain('Checking link');
  });

  test('keeps Connect disabled until the chat account is known', () => {
    const html = render(() => new Promise<never>(() => {}));
    const connect = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Connect account<\/button>/.exec(html)?.[0];

    expect(connect).toBeDefined();
    expect(connect).toMatch(/\sdisabled=""/);
  });

  // KRTX-940: an account that requires MFA refuses the first bind. The step-up
  // dialog verifies the code and dispatches `kortix:mfa-verified`; the page must
  // bind again on that event, not wait for a second click on Connect.
  test('binds again without a second click once the MFA step-up verifies', async () => {
    // bun test has no `window`; the armed retry listens on it.
    const originalWindow = globalThis.window;
    globalThis.window = new EventTarget() as unknown as Window & typeof globalThis;
    try {
      const bind = mock()
        .mockRejectedValueOnce(Object.assign(new Error('MFA required'), { code: 'account_mfa_required' }))
        .mockResolvedValueOnce({ resumed: false, hasAccess: true });
      let root!: ReturnType<typeof create>;
      await act(async () => {
        root = create(
          <ChatIdentityConnect
            service="Slack"
            token="token.sig"
            loginPath="/slack/login/token.sig"
            bind={bind}
            preview={async () => ({ service: 'slack', workspaceName: null, chatUserId: 'U1', chatUserName: null })}
            missingLinkMessage="missing"
            disconnectNote="note"
          />,
        );
      });
      const text = (node: ReactTestInstance | string): string =>
        typeof node === 'string' ? node : node.children.map(text).join('');
      const connect = root.root.findAll((n) => n.type === 'button').find((n) => text(n).includes('Connect account'));
      if (!connect) throw new Error('Connect button did not render');
      expect(connect.props.disabled).toBe(false);

      await act(async () => connect.props.onClick());
      expect(bind).toHaveBeenCalledTimes(1);
      expect(text(root.root)).toContain('MFA required');

      await act(async () => {
        window.dispatchEvent(new CustomEvent('kortix:mfa-verified'));
      });
      expect(bind).toHaveBeenCalledTimes(2);
      expect(bind).toHaveBeenLastCalledWith('token.sig');
      expect(text(root.root)).toContain('Slack connected');

      act(() => root.unmount());
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
