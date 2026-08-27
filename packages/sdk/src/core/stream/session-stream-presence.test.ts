import { beforeEach, describe, expect, test } from 'bun:test';
import {
  isSessionRuntimeChannelLive,
  isSessionStreamConnected,
  markSessionRuntimeChannelLive,
  markSessionStreamConnected,
  resetSessionStreamPresence,
  subscribeSessionStreamPresence,
} from './session-stream-presence';

beforeEach(() => resetSessionStreamPresence());

describe('session-stream presence', () => {
  test('a scope is connected while at least one connection reports connected', () => {
    expect(isSessionStreamConnected('p/s')).toBe(false);
    markSessionStreamConnected('p/s', true);
    expect(isSessionStreamConnected('p/s')).toBe(true);
    // A second connection (StrictMode double mount) stacks.
    markSessionStreamConnected('p/s', true);
    markSessionStreamConnected('p/s', false);
    expect(isSessionStreamConnected('p/s')).toBe(true);
    markSessionStreamConnected('p/s', false);
    expect(isSessionStreamConnected('p/s')).toBe(false);
  });

  test('scopes are independent', () => {
    markSessionStreamConnected('a/1', true);
    expect(isSessionStreamConnected('a/1')).toBe(true);
    expect(isSessionStreamConnected('b/2')).toBe(false);
  });

  test('subscribers are notified only when the boolean answer flips', () => {
    let notifications = 0;
    const unsubscribe = subscribeSessionStreamPresence('p/s', () => notifications++);
    markSessionStreamConnected('p/s', true);
    expect(notifications).toBe(1);
    markSessionStreamConnected('p/s', true); // 1 → 2 connections: answer unchanged
    expect(notifications).toBe(1);
    markSessionStreamConnected('p/s', false);
    expect(notifications).toBe(1);
    markSessionStreamConnected('p/s', false);
    expect(notifications).toBe(2);
    unsubscribe();
    markSessionStreamConnected('p/s', true);
    expect(notifications).toBe(2);
  });

  test('disconnect below zero never wedges the count', () => {
    markSessionStreamConnected('p/s', false);
    markSessionStreamConnected('p/s', true);
    expect(isSessionStreamConnected('p/s')).toBe(true);
  });
});

describe('runtime-channel liveness flag', () => {
  test('a scope reports the runtime channel live only after it is marked so', () => {
    expect(isSessionRuntimeChannelLive('p/s')).toBe(false);
    markSessionRuntimeChannelLive('p/s', true);
    expect(isSessionRuntimeChannelLive('p/s')).toBe(true);
    markSessionRuntimeChannelLive('p/s', false);
    expect(isSessionRuntimeChannelLive('p/s')).toBe(false);
  });

  test('the flag notifies the same subscription as presence, only on flips', () => {
    let notifications = 0;
    const unsubscribe = subscribeSessionStreamPresence('p/s', () => notifications++);
    markSessionRuntimeChannelLive('p/s', true);
    expect(notifications).toBe(1);
    markSessionRuntimeChannelLive('p/s', true);
    expect(notifications).toBe(1);
    markSessionRuntimeChannelLive('p/s', false);
    expect(notifications).toBe(2);
    unsubscribe();
  });
});
