import { describe, expect, test } from 'bun:test';
import { isMissingRuntimeError } from './resume-stopped-sandbox';

describe('isMissingRuntimeError — a start that found no box', () => {
  const err = (name: string, message: string, fields: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), { name, ...fields });

  test('a provider 404 is a missing runtime', () => {
    expect(isMissingRuntimeError(err('PlatinumHttpError', 'platinum POST /v1/sandboxes/x/start -> 404', { status: 404 }))).toBe(true);
    expect(isMissingRuntimeError(err('SandboxNotFoundError', 'Sandbox x not found'))).toBe(true);
  });

  test('gone-container text alone is not a missing runtime', () => {
    expect(isMissingRuntimeError(err('PlatinumHttpError', 'platinum POST -> 500 no such container', { status: 500 }))).toBe(false);
  });

  test('a 500 whose message says "not found" is not a missing runtime', () => {
    expect(isMissingRuntimeError(err('PlatinumHttpError', 'runner not found for region', { status: 500 }))).toBe(false);
    expect(isMissingRuntimeError(new Error('config key not found'))).toBe(false);
  });
});
