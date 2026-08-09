import { describe, expect, test } from 'bun:test';
import { classifyStopCommandResult } from '../stop-command-outcome';

describe('classifyStopCommandResult', () => {
  test('accepts only provider-confirmed stops and missing sandboxes as terminal success', () => {
    expect(classifyStopCommandResult({ status: 200, body: { status: 'stopped' } })).toBe('succeeded');
    expect(classifyStopCommandResult({ status: 404, body: { error: 'missing' } })).toBe('succeeded');
    expect(classifyStopCommandResult({ status: 409, body: { status: 'stopped' } })).toBe('succeeded');
  });

  test('retries provisioning and transient failures instead of consuming the stop', () => {
    expect(classifyStopCommandResult({ status: 409, body: { status: 'provisioning' } })).toBe('retry');
    expect(classifyStopCommandResult({ status: 429, body: {} })).toBe('retry');
    expect(classifyStopCommandResult({ status: 503, body: {} })).toBe('retry');
  });

  test('does not treat an unrelated 409 as stopped', () => {
    expect(classifyStopCommandResult({ status: 409, body: { error: 'conflict' } })).toBe('failed');
  });
});
