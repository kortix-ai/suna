import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// Identity translations: every string on these popups is a catalog key, so the
// rendered markup shows the key it renders — the strongest anchor there is.
const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => translate }));
mock.module('@/lib/onboarding/use-app-home', () => ({ useAppHome: () => '/projects/start' }));

const { default: GitHubOAuthPopup } = await import('./auth/github-popup/page');
const { default: GitHubConnectPopup } = await import('./auth/github-connect/page');

// Both popups render the same shell: centered card, logo, title, and a
// loading/processing row. The error states are unreachable in a static render
// (they need the OAuth round-trip to fail), so the shell component carries its
// own state-level assertions in features/auth/auth-popup-shell.test.tsx.
describe('GitHubOAuthPopup', () => {
  test('renders the sign-in shell in its initial loading state', () => {
    const html = renderToStaticMarkup(<GitHubOAuthPopup />);
    expect(html).toContain('appAuthGithubPopupPage.line194JsxTextGithubSignIn');
    expect(html).toContain('i18nComplete.text502698660877');
    expect(html).toContain(
      'bg-background flex min-h-svh flex-col items-center justify-center px-6',
    );
    expect(html).toContain('w-full max-w-[320px]');
    expect(html).toContain('mt-6 text-2xl font-medium tracking-tight');
  });
});

describe('GitHubConnectPopup', () => {
  test('renders the connect shell in its initial loading state', () => {
    const html = renderToStaticMarkup(<GitHubConnectPopup />);
    expect(html).toContain('appAuthGithubConnectPage.line116JsxTextConnectGithub');
    expect(html).toContain('i18nComplete.text502698660877');
    expect(html).toContain(
      'bg-background flex min-h-svh flex-col items-center justify-center px-6',
    );
    expect(html).toContain('w-full max-w-[320px]');
    expect(html).toContain('mt-6 text-2xl font-medium tracking-tight');
  });
});
