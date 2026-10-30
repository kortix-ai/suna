import { describe, expect, test } from 'bun:test';
import { ApiError } from '@kortix/sdk';
import { stopRefusalMessage } from './stop-refusal';

const MESSAGE = 'Only the member who started this run, the session owner or a project manager can stop it.';

describe('stopRefusalMessage', () => {
  test('a refused REST stop gives the server message', () => {
    expect(stopRefusalMessage(new ApiError(MESSAGE, { status: 403, code: 'not_turn_prompter' }))).toBe(MESSAGE);
  });

  test('a refused runtime abort keeps only status and message, and still counts', () => {
    expect(stopRefusalMessage(Object.assign(new Error(MESSAGE), { status: 403 }))).toBe(MESSAGE);
  });

  test('any other failure is not a refusal', () => {
    expect(stopRefusalMessage(new ApiError('Bad gateway', { status: 502, code: '502' }))).toBeNull();
    expect(stopRefusalMessage(new Error('socket hang up'))).toBeNull();
    expect(stopRefusalMessage(undefined)).toBeNull();
  });
});
