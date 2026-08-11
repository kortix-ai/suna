import { describe, expect, it } from 'vitest';
import { defaultGatewayUrl, inferTarget } from '../src/core/env';

describe('release target inference', () => {
  it('classifies the staging API and selects the staging gateway', () => {
    expect(inferTarget('https://staging-api.kortix.com/v1')).toBe('staging');
    expect(defaultGatewayUrl('staging')).toBe('https://gateway-staging.kortix.com');
  });

  it('keeps dev, prod, and local gateway defaults isolated', () => {
    expect(defaultGatewayUrl('dev')).toBe('https://gateway-dev.kortix.com');
    expect(defaultGatewayUrl('prod')).toBe('https://gateway.kortix.com');
    expect(defaultGatewayUrl('local')).toBe('http://localhost:8009');
  });

  it('preserves the explicit preview target for preview-only browser contracts', () => {
    const previous = process.env.KE2E_TARGET;
    process.env.KE2E_TARGET = 'preview';
    try {
      expect(inferTarget('https://8080-preview.daytonaproxy01.net/v1')).toBe('preview');
    } finally {
      if (previous === undefined) delete process.env.KE2E_TARGET;
      else process.env.KE2E_TARGET = previous;
    }
  });
});
