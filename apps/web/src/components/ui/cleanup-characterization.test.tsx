import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnimatedBg, ArcSvg, LEFT_ARC, RIGHT_ARC } from './animated-bg';
import { OtpVerification } from '@/features/auth/phone-verification/otp-verification';
import { fullDate, STATUS_META } from '@/lib/kortix/task-meta';

test('hero first render keeps its static gradient, hidden decoration and bottom fade', () => {
  const html = renderToStaticMarkup(<AnimatedBg duration={7} />);
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('-z-10');
  expect(html).toContain('radial-gradient(ellipse at 20% 30%');
  expect(html).toContain('bg-gradient-to-t');
});

test('both arc shapes retain geometry, tones and explicit blur', () => {
  for (const cfg of [LEFT_ARC, RIGHT_ARC]) {
    const html = renderToStaticMarkup(<ArcSvg cfg={cfg} size={100} tone="dark" opacity={0.23} blurAmount={3} />);
    expect(html).toContain(cfg.d);
    expect(html).toContain('width="100"');
    expect(html).toContain(`height="${100 * cfg.ratio}"`);
    expect(html).toContain('blur(3px)');
    expect(html).toContain('#B9B9B9');
  }
});

test('OTP idle and challenged states retain their available actions', () => {
  const props = { onVerify: async () => {}, onResend: async () => {}, onSendCode: async () => {}, onRemovePhone: async () => {} };
  const idle = renderToStaticMarkup(<OtpVerification {...props} />);
  const challenged = renderToStaticMarkup(<OtpVerification {...props} challengeId="synthetic-challenge" />);
  expect(idle).toContain('Send Verification Code');
  expect(idle).toContain('Remove Phone Number');
  expect(challenged).toContain('Verify Code');
  expect(challenged).not.toContain('Remove Phone Number');
});

test('retained task presentation keeps ordered statuses and nullable dates', () => {
  expect(Object.values(STATUS_META).map((status) => status.order)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(fullDate(null)).toBe('');
  expect(fullDate('2026-01-01T12:00:00Z')).toBe(new Date('2026-01-01T12:00:00Z').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }));
});
