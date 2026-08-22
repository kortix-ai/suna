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
});
