import { describe, expect, test } from 'bun:test';
import { classifyGatewayLogReference } from './gateway-log-reference';

describe('classifyGatewayLogReference', () => {
  test('treats UUID references as ambiguous because both ids use UUIDs', () => {
    expect(classifyGatewayLogReference('e6117078-2f86-4c83-a205-09372912e165')).toBe('both');
  });

  test('treats prefixed request ids as request ids only', () => {
    expect(classifyGatewayLogReference('req_gateway_1')).toBe('request');
  });

  test('rejects malformed references', () => {
    expect(classifyGatewayLogReference('not-an-id')).toBe('invalid');
  });
});
