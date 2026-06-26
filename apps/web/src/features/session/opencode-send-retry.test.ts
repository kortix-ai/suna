import { describe, expect, test } from 'bun:test';

import {
  FIRST_MESSAGE_SEND_BACKOFF_MS,
  isTransientSendStatus,
  sendMaxAttempts,
  sendRetryDelayMs,
  shouldRetrySend,
} from './opencode-send-retry';

describe('opencode send retry policy', () => {
  test('treats a missing status (thrown network error) as transient', () => {
    expect(isTransientSendStatus(undefined)).toBe(true);
  });

  test('treats 5xx, 408 and 429 as transient', () => {
    expect(isTransientSendStatus(500)).toBe(true);
    expect(isTransientSendStatus(503)).toBe(true);
    expect(isTransientSendStatus(599)).toBe(true);
    expect(isTransientSendStatus(408)).toBe(true);
    expect(isTransientSendStatus(429)).toBe(true);
  });

  test('treats ordinary 4xx as non-transient', () => {
    expect(isTransientSendStatus(400)).toBe(false);
    expect(isTransientSendStatus(401)).toBe(false);
    expect(isTransientSendStatus(403)).toBe(false);
    expect(isTransientSendStatus(404)).toBe(false);
    expect(isTransientSendStatus(422)).toBe(false);
  });

  test('treats 2xx/3xx as non-transient', () => {
    expect(isTransientSendStatus(200)).toBe(false);
    expect(isTransientSendStatus(204)).toBe(false);
    expect(isTransientSendStatus(304)).toBe(false);
  });

  test('first-message backoff has nine total attempts ending in an 8s plateau', () => {
    expect(sendMaxAttempts(FIRST_MESSAGE_SEND_BACKOFF_MS)).toBe(9);
    expect(FIRST_MESSAGE_SEND_BACKOFF_MS).toEqual([400, 800, 1500, 3000, 5000, 8000, 8000, 8000]);
  });

  test('retries the 503 "opencode not ready" race while attempts remain', () => {
    const backoff = FIRST_MESSAGE_SEND_BACKOFF_MS;
    expect(shouldRetrySend(503, 1, backoff)).toBe(true);
    expect(shouldRetrySend(503, 8, backoff)).toBe(true);
  });

  test('stops retrying once the final attempt is reached', () => {
    const backoff = FIRST_MESSAGE_SEND_BACKOFF_MS;
    expect(shouldRetrySend(503, sendMaxAttempts(backoff), backoff)).toBe(false);
  });

  test('never retries a non-transient failure even on the first attempt', () => {
    expect(shouldRetrySend(400, 1, FIRST_MESSAGE_SEND_BACKOFF_MS)).toBe(false);
    expect(shouldRetrySend(404, 1, FIRST_MESSAGE_SEND_BACKOFF_MS)).toBe(false);
  });

  test('maps each attempt to its backoff delay and clamps past the end', () => {
    expect(sendRetryDelayMs(1, FIRST_MESSAGE_SEND_BACKOFF_MS)).toBe(400);
    expect(sendRetryDelayMs(8, FIRST_MESSAGE_SEND_BACKOFF_MS)).toBe(8000);
    expect(sendRetryDelayMs(99, FIRST_MESSAGE_SEND_BACKOFF_MS)).toBe(0);
  });
});
