import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// bun test has no window; the redirect effects read window.location.href
// (oauth, github setup) and window.localStorage (github setup). The href is
// mutable per test because the signed-out target is the CURRENT document URL.
let currentHref = 'https://app.kortix.test/oauth/authorize?request_id=req_1';
Object.assign(globalThis, {
  window: {
    location: {
      get href() {
        return currentHref;
      },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  },
});

const replaces: string[] = [];
const search = 'callback=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback&state=n0nce';
mock.module('next/navigation', () => ({
  useRouter: () => ({
    replace: (url: string) => replaces.push(url),
    push: () => {},
    prefetch: () => {},
  }),
  usePathname: () => '/',
  useSearchParams: () => ({
    get: (key: string) =>
      key === 'request_id'
        ? 'req_1'
        : key === 'state'
          ? 'n0nce'
          : key === 'callback'
            ? 'http://127.0.0.1:8765/callback'
            : null,
    toString: () => search,
  }),
  useParams: () => ({ code: 'c0de' }),
}));

const translate = Object.assign((key: string) => key, {
  raw: (key: string) => key,
  // `t.rich` renders embedded links (the legal footer); the key is the anchor.
  rich: (key: string) => key,
  has: () => true,
});
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => translate }));
let authState: { user: unknown; isLoading: boolean } = { user: null, isLoading: false };
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => authState,
}));
mock.module('@/lib/onboarding/use-app-home', () => ({ useAppHome: () => '/projects/start' }));
mock.module('@/features/tunnel/types', () => ({ localizedCapabilityRegistry: () => [] }));
mock.module('@/hooks/tunnel/use-tunnel', () => ({
  useDeviceAuthInfo: () => ({ data: undefined, isLoading: false, error: null }),
  useApproveDeviceAuth: () => ({ isPending: false, mutateAsync: async () => {} }),
  useDenyDeviceAuth: () => ({ isPending: false, mutateAsync: async () => {} }),
}));
mock.module('@/features/workspace/project-selector/use-project-selector-data', () => ({
  useProjectSelectorData: () => ({ sections: [] }),
}));
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: false }),
}));

const { default: OAuthAuthorizePage } = await import('./oauth/authorize/page');
const { default: GitHubSetupPage } = await import('./github/setup/page');
const { default: DeviceAuthorizePage } = await import('./tunnel/authorize/[code]/page');
const { default: CliAuthorizePage } = await import('./cli/authorize/page');

async function renderSignedOut(page: React.ComponentType) {
  replaces.length = 0;
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(page));
  });
  if (!renderer) throw new Error('page did not render');
  await act(async () => {
    renderer?.unmount();
  });
  return replaces;
}

describe('signed-out gate on the consent pages', () => {
  beforeEach(() => {
    authState = { user: null, isLoading: false };
  });

  test('no redirect while the auth state is still loading — a signed-in hard load must not flash /auth', async () => {
    // The copied effects all gated on `!isLoading && !user`; this pins the
    // same patience in the shared hook.
    authState = { user: null, isLoading: true };
    expect(await renderSignedOut(OAuthAuthorizePage)).toEqual([]);
    expect(await renderSignedOut(CliAuthorizePage)).toEqual([]);
  });

  test('the redirect fires once the loading resolves signed-out, and only then', async () => {
    // Render 1: still loading — no redirect (covered above). Render 2 with the
    // same signed-out identity resolved: the gate fires. A transition inside
    // one mount re-runs the same effect via the [isLoading, user] deps.
    authState = { user: null, isLoading: false };
    expect(await renderSignedOut(OAuthAuthorizePage)).toEqual([
      `/auth?returnUrl=${encodeURIComponent('/oauth/authorize?request_id=req_1')}`,
    ]);
  });

  test('a signed-in visitor is never redirected', async () => {
    authState = { user: { id: 'u1' }, isLoading: false };
    expect(await renderSignedOut(OAuthAuthorizePage)).toEqual([]);
    expect(await renderSignedOut(GitHubSetupPage)).toEqual([]);
  });
  test('oauth/authorize redirects to /auth carrying the current URL as returnUrl', async () => {
    const replaces = await renderSignedOut(OAuthAuthorizePage);
    expect(replaces).toEqual([
      `/auth?returnUrl=${encodeURIComponent('/oauth/authorize?request_id=req_1')}`,
    ]);
  });

  test('github/setup redirects to /auth carrying the current URL as returnUrl', async () => {
    currentHref = 'https://app.kortix.test/github/setup?installation_id=i_1&state=s_1';
    const replaces = await renderSignedOut(GitHubSetupPage);
    expect(replaces).toEqual([
      `/auth?returnUrl=${encodeURIComponent('/github/setup?installation_id=i_1&state=s_1')}`,
    ]);
  });

  test('tunnel/authorize/[code] redirects to /auth carrying its own fixed path', async () => {
    const replaces = await renderSignedOut(DeviceAuthorizePage);
    expect(replaces).toEqual([`/auth?returnUrl=${encodeURIComponent('/tunnel/authorize/c0de')}`]);
  });

  test('cli/authorize redirects to /auth carrying its full query as the return destination', async () => {
    // The destination — where sign-in sends the user back — is what matters;
    // /auth resolves the `redirect` and `returnUrl` params into the same
    // sanitizer, so the param NAME this pins is whichever one the page sends.
    const replaces = await renderSignedOut(CliAuthorizePage);
    expect(replaces).toHaveLength(1);
    const target = new URL(replaces[0]!, 'https://app.kortix.test');
    expect(target.pathname).toBe('/auth');
    const carried = target.searchParams.get('returnUrl') ?? target.searchParams.get('redirect');
    expect(carried).toBe(`/cli/authorize?${search}`);
  });
});
