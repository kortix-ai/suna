import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// The consent screen links a chat account to the signed-in Kortix user. It must
// name that chat account before Connect is usable: the preview is fetched after
// mount, so the first render shows the pending row and a disabled Connect.

mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { email: 'member@example.com' }, isLoading: false }),
}));
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
    const connect = /<button[^>]*>(?:(?!<\/button>).)*Connect account<\/button>/s.exec(html)?.[0];

    expect(connect).toBeDefined();
    expect(connect).toMatch(/\sdisabled=""/);
  });
});
