import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
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

/**
 * KRTX-2516: Continue emails a NEW address the signup confirmation ("Confirm
 * your email") and an existing one the sign-in link. The page does not know
 * which (no account enumeration), so the "Check your email" copy names neither:
 * it says a link was sent. "Sign-in link" mislabeled every new signup's email.
 *
 * KRTX-2195: "a link" still mislabeled the new signup's email — the mail says
 * "Confirm your email" while the page said "We sent a link", so a user waiting
 * for a link read the confirmation mail as the wrong message. The send action
 * does resolve the flow mode server-side; it now answers with it, and the step
 * names the confirmation email for a signup while keeping the generic link
 * copy when the mode is unknown (the old fail-open, KRTX-2516).
 */
describe('link step copy names the link, not its kind', () => {
  for (const [locale, wording] of Object.entries(SIGN_IN_WORDING)) {
    test(`${locale}: the description says a link was sent`, () => {
      const catalog = JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../../../../../translations/${locale}.json`, import.meta.url)),
          'utf8',
        ),
      );
      const description: string = catalog.auth.unified.link.description;
      expect(description).toContain('<address>{email}</address>');
      expect(description).not.toMatch(wording);
    });
  }
});

test('mode=signup: the copy names the confirmation email the mailbox actually receives', () => {
  const markup = renderToStaticMarkup(
    <EmailLinkStep
      mode="signup"
      sentEmail="synthetic@example.test"
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
  expect(markup).toContain('We sent a confirmation email to');
  expect(markup).toContain('Confirm your email to continue');
  expect(markup).toContain('Didn&#x27;t receive the confirmation email?');
  expect(markup).not.toContain('We sent a link');
  expect(markup).not.toContain('Didn&#x27;t receive the link?');
});

test('mode other than signup keeps the generic link copy (fail-open, KRTX-2516)', () => {
  for (const mode of [undefined, 'unknown', 'signin'] as const) {
    const markup = renderToStaticMarkup(
      <EmailLinkStep
        mode={mode}
        sentEmail="synthetic@example.test"
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
    expect(markup).toContain('Didn&#x27;t receive the link?');
    expect(markup).not.toContain('confirmation email');
  }
});

test('every locale carries the confirmation copy with the address placeholder', () => {
  for (const locale of Object.keys(SIGN_IN_WORDING)) {
    const catalog = JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../../../translations/${locale}.json`, import.meta.url)),
        'utf8',
      ),
    );
    const link = catalog.auth.unified.link;
    expect(link.confirmDescription.trim().length, locale).toBeGreaterThan(0);
    expect(link.confirmNotReceived.trim().length, locale).toBeGreaterThan(0);
    expect(link.confirmDescription, locale).toContain('<address>{email}</address>');
    expect(link.confirmDescription, locale).not.toMatch(/\b(link|lien|enlace|リンク|链接|линк)/i);
  }
});

for (const mode of ['signup', 'signin', 'unknown'] as const) {
  test(`${mode}: the code input shows at once, beside the link`, () => {
    const markup = renderToStaticMarkup(
      <EmailLinkStep
        mode={mode}
        sentEmail={null}
        errorMessage={null}
        info={null}
        resendIn={0}
        pending={false}
        pendingAction={null}
        passwordEnabled={false}
        onResend={() => {}}
        onChangeEmail={() => {}}
        onPassword={() => {}}
        onCodeChange={() => {}}
        onVerify={() => {}}
      />,
    );
    const document = new Window().document;
    document.body.innerHTML = markup;
    const codeInput = document.querySelector('input[autocomplete="one-time-code"]');
    expect(codeInput).not.toBeNull();
    expect(codeInput?.closest('details')).toBeNull();
    expect(markup).toContain(
      mode === 'signup' ? 'Confirm your email to continue' : 'Open it to continue',
    );
  });
}
