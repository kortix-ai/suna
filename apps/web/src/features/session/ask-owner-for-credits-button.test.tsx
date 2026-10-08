import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';
import { NextIntlClientProvider } from 'next-intl';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { AskOwnerForCreditsButton } from './ask-owner-for-credits-button';

let renderer: ReactTestRenderer | null = null;
let requests: Array<{ url: string; method: string }> = [];
let reply: { status: number; body: unknown } = { status: 202, body: { notified: 1 } };
const realFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (url: unknown, init: RequestInit = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET' });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
});

function mount() {
  act(() => {
    renderer = create(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <AskOwnerForCreditsButton accountId="acc_1" />
      </NextIntlClientProvider>,
    );
  });
  return renderer!.root.findByType('button');
}

const text = (button: ReturnType<typeof mount>) => JSON.stringify(button.props.children);

// KRTX-1718: a member out of credits can tell the owners from the notice.
describe('Ask an owner', () => {
  test('asks the account owners, then says they were notified', async () => {
    const button = mount();
    expect(text(button)).toContain('Ask an owner');
    await act(async () => {
      button.props.onClick();
    });
    expect(requests).toEqual([{ url: 'http://api.test/v1/accounts/acc_1/top-up-requests', method: 'POST' }]);
    const after = renderer!.root.findByType('button');
    expect(text(after)).toContain('Owners notified');
    expect(after.props.disabled).toBe(true);
  });

  test('a second ask the same day says so', async () => {
    reply = { status: 429, body: { error: 'You already asked', code: 'already_requested' } };
    const button = mount();
    await act(async () => {
      button.props.onClick();
    });
    const after = renderer!.root.findByType('button');
    expect(text(after)).toContain('Already asked today');
    expect(after.props.disabled).toBe(true);
  });

  test('a failure lets the member try again', async () => {
    reply = { status: 500, body: { error: 'boom' } };
    const button = mount();
    await act(async () => {
      button.props.onClick();
    });
    const after = renderer!.root.findByType('button');
    expect(text(after)).toContain("Couldn't reach the owners");
    expect(after.props.disabled).toBe(false);
  });
});
