import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createTraffic } from './traffic';

const busy = { provider: 'kortix', requestedModel: 'deepseek-v4.1-flash', ok: true, status: 200, attempts: 2,
  attemptFailures: [{ attempt: 1, provider: 'kortix', routeModel: 'deepseek-v4.1-flash', resolvedModel: 'deepseek-v4.1-flash', stage: 'dispatch' as const, status: 429, code: 'model_busy', message: '' }] };
const clean = { provider: 'kortix', requestedModel: 'deepseek-v4.1-flash', ok: true, status: 200, attempts: 1 };

afterEach(() => setSystemTime());

describe('upstream capacity incidents', () => {
  test('a model whose requests meet upstream 429s is an incident even when every request was answered', () => {
    setSystemTime(new Date('2026-10-18T12:00:00Z'));
    const traffic = createTraffic();
    for (let i = 0; i < 14; i++) traffic.recordUpstream(busy);
    for (let i = 0; i < 6; i++) traffic.recordUpstream(clean);
    expect(traffic.upstreamIncidents()).toEqual([
      'upstream capacity: deepseek-v4.1-flash 70% of 20 requests met an upstream failure (429x14) over 300s',
    ]);
    // The window moves on: the same counts five minutes later are gone.
    setSystemTime(new Date('2026-10-18T12:05:01Z'));
    expect(traffic.upstreamIncidents()).toEqual([]);
  });

  test('low volume, a low share, a client cancel or an own-key request is not an incident', () => {
    const traffic = createTraffic();
    for (let i = 0; i < 19; i++) traffic.recordUpstream(busy);
    expect(traffic.upstreamIncidents()).toEqual([]);
    for (let i = 0; i < 80; i++) traffic.recordUpstream(clean);
    expect(traffic.upstreamIncidents()).toEqual([]);
    const other = createTraffic();
    for (let i = 0; i < 30; i++) {
      other.recordUpstream({ ...busy, ok: false, status: 499, errorCode: 'client_aborted', attemptFailures: [] });
      other.recordUpstream({ ...busy, provider: 'openrouter' });
    }
    expect(other.upstreamIncidents()).toEqual([]);
  });

  test('an upstream 402 with no fallback counts; an account out of credits does not', () => {
    const traffic = createTraffic();
    for (let i = 0; i < 20; i++) traffic.recordUpstream({ provider: 'kortix', requestedModel: 'glm-5.3-flash', ok: false, status: 402, attempts: 1, attemptFailures: [] });
    expect(traffic.upstreamIncidents()[0]).toContain('glm-5.3-flash 100% of 20 requests met an upstream failure (402x20)');
    const broke = createTraffic();
    for (let i = 0; i < 20; i++) broke.recordUpstream({ provider: 'kortix', requestedModel: 'glm-5.3-flash', ok: false, status: 402, errorCode: 'insufficient_credits', attempts: 0 });
    expect(broke.upstreamIncidents()).toEqual([]);
  });
});
