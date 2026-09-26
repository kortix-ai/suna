import { describe, expect, test } from 'bun:test';
import { isTrustedPreviewOrigin } from './preview-origin-trust';

const TEMPLATE = 'https://prod-p{port}-{sandbox}.p.kortix.com';

describe('isTrustedPreviewOrigin — only this deployment\'s preview origins get a credential', () => {
  test('a URL built from the advertised template is trusted', () => {
    expect(
      isTrustedPreviewOrigin('https://prod-p3000-sbx-a1.p.kortix.com/app?x=1', {
        templates: [TEMPLATE],
        backendUrls: ['https://api.kortix.com/v1'],
      }),
    ).toBe(true);
  });

  test('a host that only LOOKS like a preview origin is not trusted', () => {
    const opts = { templates: [TEMPLATE], backendUrls: ['https://api.kortix.com/v1'] };
    // A Kortix App host whose slug starts with `p<digits>-`.
    expect(isTrustedPreviewOrigin('https://prod-p3000-x-0123456789abcdef.apps.kortix.com/', opts)).toBe(false);
    // A foreign host with the preview label shape.
    expect(isTrustedPreviewOrigin('https://p80-anything.attacker.example/', opts)).toBe(false);
    expect(isTrustedPreviewOrigin('https://prod-p3000-sbx.p.kortix.com.attacker.example/', opts)).toBe(false);
    // Right domain, wrong environment prefix.
    expect(isTrustedPreviewOrigin('https://dev-p3000-sbx.p.kortix.com/', opts)).toBe(false);
    // Right host, wrong scheme.
    expect(isTrustedPreviewOrigin('http://prod-p3000-sbx.p.kortix.com/', opts)).toBe(false);
    // Right host shape, but a nested label in the sandbox slot.
    expect(isTrustedPreviewOrigin('https://prod-p3000-a.b.p.kortix.com/', opts)).toBe(false);
  });

  test('with no template known, no deployed origin is trusted', () => {
    expect(
      isTrustedPreviewOrigin('https://prod-p3000-sbx-a1.p.kortix.com/', {
        templates: [],
        backendUrls: ['https://api.kortix.com/v1'],
      }),
    ).toBe(false);
  });

  test('the local origin form is trusted only on the local backend\'s own port', () => {
    const local = { templates: [], backendUrls: ['http://localhost:8008/v1'] };
    expect(isTrustedPreviewOrigin('http://p3211-sbx-a.localhost:8008/open', local)).toBe(true);
    expect(isTrustedPreviewOrigin('http://p3211-sbx-a.localhost:9999/open', local)).toBe(false);
    // A deployed backend never makes a *.localhost URL trusted.
    expect(
      isTrustedPreviewOrigin('http://p3211-sbx-a.localhost:8008/open', {
        templates: [TEMPLATE],
        backendUrls: ['https://api.kortix.com/v1'],
      }),
    ).toBe(false);
  });

  test('malformed input is never trusted', () => {
    const opts = { templates: [TEMPLATE, 'not a template'], backendUrls: ['::'] };
    expect(isTrustedPreviewOrigin('not a url', opts)).toBe(false);
    expect(isTrustedPreviewOrigin('', opts)).toBe(false);
  });

  test('template characters are matched literally, not as a pattern', () => {
    // `.` in the template must not match any character.
    expect(
      isTrustedPreviewOrigin('https://prod-p3000-sbx.pxkortixxcom/', {
        templates: [TEMPLATE],
        backendUrls: [],
      }),
    ).toBe(false);
  });
});
