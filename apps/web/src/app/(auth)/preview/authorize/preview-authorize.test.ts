import { describe, expect, it } from 'bun:test';
import { isServablePreviewUrl } from './page';

const TEMPLATE = 'https://dev-p{port}-{sandbox}.p.kortix.com';

describe('isServablePreviewUrl', () => {
  it('accepts a preview origin this deployment serves', () => {
    expect(
      isServablePreviewUrl('https://dev-p8081-sbx-01m0g4hxcm32bx5r1gpyzdyc1h.p.kortix.com/learn', TEMPLATE),
    ).toBe(true);
  });

  it('keeps the whole path and query — it is only the host that is checked', () => {
    expect(isServablePreviewUrl('https://dev-p3000-sbx-a.p.kortix.com/a/b?c=1#d', TEMPLATE)).toBe(true);
  });

  // Everything below would be an open redirect that also hands over a bearer
  // token, which is why this function exists at all.
  it('refuses another domain', () => {
    expect(isServablePreviewUrl('https://evil.example.com/', TEMPLATE)).toBe(false);
  });

  it('refuses a lookalike that merely contains the domain', () => {
    expect(isServablePreviewUrl('https://dev-p8081-x.p.kortix.com.evil.example/', TEMPLATE)).toBe(false);
  });

  it('refuses a nested label that escapes the wildcard certificate', () => {
    expect(isServablePreviewUrl('https://a.dev-p8081-x.p.kortix.com/', TEMPLATE)).toBe(false);
  });

  it('refuses another environment’s prefix', () => {
    expect(isServablePreviewUrl('https://prod-p8081-x.p.kortix.com/', TEMPLATE)).toBe(false);
  });

  it('refuses the API host and the app’s own origin', () => {
    expect(isServablePreviewUrl('https://dev-api.kortix.com/v1/p/sbx_a/8081/', TEMPLATE)).toBe(false);
    expect(isServablePreviewUrl('https://dev.kortix.com/projects', TEMPLATE)).toBe(false);
  });

  it('refuses a downgrade to http', () => {
    expect(isServablePreviewUrl('http://dev-p8081-x.p.kortix.com/', TEMPLATE)).toBe(false);
  });

  it('refuses a malformed label', () => {
    expect(isServablePreviewUrl('https://dev-p-x.p.kortix.com/', TEMPLATE)).toBe(false);
    expect(isServablePreviewUrl('https://dev-8081-x.p.kortix.com/', TEMPLATE)).toBe(false);
  });

  it('refuses everything when the deployment serves no preview domain', () => {
    expect(isServablePreviewUrl('https://dev-p8081-x.p.kortix.com/', null)).toBe(false);
  });

  it('refuses junk', () => {
    expect(isServablePreviewUrl('', TEMPLATE)).toBe(false);
    expect(isServablePreviewUrl('not a url', TEMPLATE)).toBe(false);
    expect(isServablePreviewUrl('javascript:alert(1)', TEMPLATE)).toBe(false);
  });
});
