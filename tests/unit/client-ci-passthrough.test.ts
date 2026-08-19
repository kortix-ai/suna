import { describe, expect, it } from 'vitest';
import { CI_PASSTHROUGH_HEADER, applyCiPassthrough } from '../src/core/client';

describe('applyCiPassthrough — edge origin-status passthrough opt-in', () => {
  it('sends nothing when the secret is unset or blank', () => {
    for (const secret of [undefined, '', '   ']) {
      const h = new Headers();
      applyCiPassthrough(h, secret);
      expect(h.has(CI_PASSTHROUGH_HEADER)).toBe(false);
    }
  });

  it('sends the trimmed secret as X-Kortix-CI-Passthrough when set', () => {
    const h = new Headers();
    applyCiPassthrough(h, '  s3cret  ');
    expect(h.get(CI_PASSTHROUGH_HEADER)).toBe('s3cret');
  });

  it('never overrides a caller-supplied header value', () => {
    const h = new Headers();
    h.set(CI_PASSTHROUGH_HEADER, 'explicit');
    applyCiPassthrough(h, 'from-env');
    expect(h.get(CI_PASSTHROUGH_HEADER)).toBe('explicit');
  });
});
