import { afterEach, describe, expect, test } from 'bun:test';

import {
  CSP_REPORT_PATH,
  embedContentSecurityPolicy,
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
    // script-src is enforced (it was report-only for one release cycle), and it
    // is the same allowlist the report-only header carries.
    expect(policy.get('script-src')).toEqual(
      directives(reportOnlyContentSecurityPolicy()).get('script-src'),
    );
  });

  test('the embed policy opens framing for host pages and keeps the other enforced directives', () => {
    const policy = directives(embedContentSecurityPolicy());

    expect(policy.get('frame-ancestors')).toEqual(["'self'", 'https://kortix.com', 'https://*.kortix.com']);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    // The embed carries the same report-only script policy as every page.
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

describe('content security policy in next dev', () => {
  const env = process.env as Record<string, string | undefined>;
  const nodeEnv = env.NODE_ENV;
  // process.env stores `undefined` as the string "undefined": delete instead.
  const setNodeEnv = (value: string | undefined) => {
    if (value === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = value;
  };
  afterEach(() => setNodeEnv(nodeEnv));
  const scriptSrc = (policy: () => string) => directives(policy()).get('script-src')!;

  test('next dev allows eval, for React development call stacks', () => {
    setNodeEnv('development');

    expect(scriptSrc(enforcedContentSecurityPolicy)).toContain("'unsafe-eval'");
    expect(scriptSrc(reportOnlyContentSecurityPolicy)).toContain("'unsafe-eval'");
  });

  test('a production build and tests do not allow eval', () => {
    for (const value of ['production', 'test', undefined]) {
      setNodeEnv(value);

      expect(scriptSrc(enforcedContentSecurityPolicy)).not.toContain("'unsafe-eval'");
      expect(scriptSrc(reportOnlyContentSecurityPolicy)).not.toContain("'unsafe-eval'");
      // WebAssembly compilation stays allowed everywhere.
      expect(scriptSrc(enforcedContentSecurityPolicy)).toContain("'wasm-unsafe-eval'");
    }
  });
});
