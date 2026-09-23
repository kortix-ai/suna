import { describe, expect, test } from 'bun:test';
import { isSafeExternalLink } from './safe-link';

describe('isSafeExternalLink', () => {
  test('allows http, https, and mailto', () => {
    expect(isSafeExternalLink('https://kortix.com/docs')).toBe(true);
    expect(isSafeExternalLink('http://example.com')).toBe(true);
    expect(isSafeExternalLink('mailto:team@example.com')).toBe(true);
  });

  test('ignores scheme case and surrounding whitespace', () => {
    expect(isSafeExternalLink('HTTPS://EXAMPLE.COM')).toBe(true);
    expect(isSafeExternalLink('  MailTo:a@b.c\n')).toBe(true);
    expect(isSafeExternalLink('\t https://example.com ')).toBe(true);
  });

  test('rejects script and data schemes, including mixed case and padding', () => {
    expect(isSafeExternalLink('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalLink('  JavaScript:alert(1)')).toBe(false);
    expect(isSafeExternalLink('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeExternalLink('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
  });

  test('rejects app, intent, file, and phone schemes', () => {
    expect(isSafeExternalLink('intent://scan/#Intent;scheme=zxing;end')).toBe(false);
    expect(isSafeExternalLink('kortix://auth/callback?x=1')).toBe(false);
    expect(isSafeExternalLink('file:///etc/hosts')).toBe(false);
    expect(isSafeExternalLink('tel:+15555550100')).toBe(false);
    expect(isSafeExternalLink('sms:+15555550100')).toBe(false);
    expect(isSafeExternalLink('market://details?id=x')).toBe(false);
  });

  test('rejects relative paths, protocol-relative URLs, and look-alikes', () => {
    expect(isSafeExternalLink('/projects/123')).toBe(false);
    expect(isSafeExternalLink('docs/readme.md')).toBe(false);
    expect(isSafeExternalLink('#section')).toBe(false);
    expect(isSafeExternalLink('//evil.example/x')).toBe(false);
    expect(isSafeExternalLink('https-evil://x')).toBe(false);
    expect(isSafeExternalLink('xhttps://x')).toBe(false);
  });

  test('rejects empty and non-string values', () => {
    expect(isSafeExternalLink('')).toBe(false);
    expect(isSafeExternalLink('   ')).toBe(false);
    expect(isSafeExternalLink(undefined)).toBe(false);
    expect(isSafeExternalLink(null)).toBe(false);
    expect(isSafeExternalLink(42)).toBe(false);
  });
});
