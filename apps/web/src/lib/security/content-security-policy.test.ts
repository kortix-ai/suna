import { describe, expect, test } from 'bun:test';

import {
  CSP_REPORT_PATH,
  enforcedContentSecurityPolicy,
  reportOnlyContentSecurityPolicy,
} from './content-security-policy';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...values]) => [name!, values]),
  );
}

describe('content security policy', () => {
  test('the enforced policy keeps framing to this origin and blocks plugins and <base>', () => {
    const policy = directives(enforcedContentSecurityPolicy());

    expect(policy.get('frame-ancestors')).toEqual(["'self'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    // script-src is report-only until the reports are clean; see the module comment.
    expect(policy.has('script-src')).toBe(false);
  });

  test('the report-only policy allowlists script hosts and reports to the collector', () => {
    const policy = directives(reportOnlyContentSecurityPolicy());
    const scriptSrc = policy.get('script-src')!;

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain('https://www.googletagmanager.com');
    expect(scriptSrc).toContain('https://js.stripe.com');
    expect(scriptSrc).not.toContain('*');
    expect(scriptSrc).not.toContain('https:');
    expect(policy.get('report-uri')).toEqual([CSP_REPORT_PATH]);
  });
});
