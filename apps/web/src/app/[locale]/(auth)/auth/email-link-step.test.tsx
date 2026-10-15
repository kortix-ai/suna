import { describe, expect, test } from 'bun:test';
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
    expect(markup).toContain('sign-in link');
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
