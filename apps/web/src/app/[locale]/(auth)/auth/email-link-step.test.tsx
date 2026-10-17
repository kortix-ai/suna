import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmailLinkStep } from './email-link-step';

describe('emailed link confirmation', () => {
  test('renders the delivered mechanism rather than a six-digit code entry', () => {
    const markup = renderToStaticMarkup(
      <EmailLinkStep
        sentEmail={null}
        errorMessage={null}
        info={null}
        resendIn={0}
        pending={false}
        pendingAction={null}
        passwordEnabled={true}
        onResend={() => {}}
        onChangeEmail={() => {}}
        onPassword={() => {}}
      />,
    );
    expect(markup).toContain('We sent a link to');
    expect(markup).toContain('Open it to continue');
    expect(markup).toContain('Resend');
    expect(markup).toContain('Use a different email');
    expect(markup).toContain('Use a password instead');
    expect(markup).not.toContain('autocomplete="one-time-code"');
    expect(markup).not.toContain('inputMode="numeric"');
    expect(markup).not.toContain('six-digit');
  });
});

test('a failed resend remains visible beside the retry action', () => {
  const markup = renderToStaticMarkup(
    <EmailLinkStep
      sentEmail="synthetic@example.test"
      errorMessage="Email rate limit exceeded. Try again later."
      info={null}
      resendIn={0}
      pending={false}
      pendingAction={null}
      passwordEnabled={true}
      onResend={() => {}}
      onChangeEmail={() => {}}
      onPassword={() => {}}
    />,
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain('Email rate limit exceeded. Try again later.');
  expect(markup).toContain('Resend');
});

/**
 * KRTX-2516: Continue emails a NEW address the signup confirmation ("Confirm
 * your email") and an existing one the sign-in link. The page does not know
 * which (no account enumeration), so the "Check your email" copy names neither:
 * it says a link was sent. "Sign-in link" mislabeled every new signup's email.
 */
describe('link step copy names the link, not its kind', () => {
  const SIGN_IN_WORDING: Record<string, RegExp> = {
    en: /sign-in/i,
    de: /Anmeldelink/,
    es: /de acceso/,
    fr: /de connexion/,
    it: /di accesso/,
    ja: /ログイン/,
    pt: /de acesso/,
    sr: /за пријаву/,
    zh: /登录/,
  };
  for (const [locale, wording] of Object.entries(SIGN_IN_WORDING)) {
    test(`${locale}: the description says a link was sent`, () => {
      const catalog = JSON.parse(
        readFileSync(fileURLToPath(new URL(`../../../../../translations/${locale}.json`, import.meta.url)), 'utf8'),
      );
      const description: string = catalog.auth.unified.link.description;
      expect(description).toContain('<address>{email}</address>');
      expect(description).not.toMatch(wording);
    });
  }
});
