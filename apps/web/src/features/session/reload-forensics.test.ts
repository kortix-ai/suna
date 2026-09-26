import { describe, expect, test } from 'bun:test';
import {
  HEAP_PRESSURE_BYTES,
  classifyReloadCause,
  isInvoluntaryLoad,
  shouldReportReloadCause,
} from './reload-forensics';

describe('isInvoluntaryLoad', () => {
  test('a discarded tab is involuntary — Chrome dropped it, the user did not', () => {
    expect(
      isInvoluntaryLoad({
        discarded: true,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: null,
      }),
    ).toBe(true);
  });

  test('a chunk that failed just before the reload is involuntary', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: 'Loading chunk 4821 failed',
        heapBeforeReload: null,
      }),
    ).toBe(true);
  });

  // A person pressing cmd+R looks identical to an automatic reload in the
  // navigation entry, so reporting every 'reload' would bury the real signal.
  test('a bare reload is NOT reported — it is indistinguishable from cmd+R', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: 200_000_000,
      }),
    ).toBe(false);
  });

  // A renderer that Chrome kills for memory reports NOTHING: not discarded, a
  // plain 'reload', no chunk error. The only fingerprint is what the tab was
  // holding a moment earlier, which is why the previous life records it.
  test('a reload preceded by heap pressure IS reported', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: HEAP_PRESSURE_BYTES,
      }),
    ).toBe(true);
  });

  test('heap pressure without a reload is not a reload report', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'navigate',
        recentChunkError: null,
        heapBeforeReload: HEAP_PRESSURE_BYTES * 2,
      }),
    ).toBe(false);
  });

  test('a missing heap sample never counts as pressure', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: null,
      }),
    ).toBe(false);
  });

  test('an ordinary navigation is not reported', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'navigate',
        recentChunkError: null,
        heapBeforeReload: null,
      }),
    ).toBe(false);
  });
});

describe('classifyReloadCause', () => {
  test('names a discarded tab', () => {
    expect(
      classifyReloadCause({
        discarded: true,
        navigationType: 'back_forward',
        recentChunkError: null,
        heapBeforeReload: 120_000_000,
      }),
    ).toBe('discarded');
  });

  test('a chunk failure wins over a discard', () => {
    expect(
      classifyReloadCause({
        discarded: true,
        navigationType: 'back_forward',
        recentChunkError: 'Loading chunk 4821 failed',
        heapBeforeReload: null,
      }),
    ).toBe('chunk-error');
  });

  test('names a renderer killed under heap pressure', () => {
    expect(
      classifyReloadCause({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: HEAP_PRESSURE_BYTES,
      }),
    ).toBe('renderer-oom');
  });

  // A discard wins over a bare heap-pressure reload: the tab was reclaimed by
  // the browser, so the heap number is not evidence of an app-driven OOM.
  test('a discard masks heap pressure', () => {
    expect(
      classifyReloadCause({
        discarded: true,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: HEAP_PRESSURE_BYTES * 2,
      }),
    ).toBe('discarded');
  });

  // A chunk failure older than the 30s freshness window is already dropped by
  // `readReloadForensics`, so a discarded tab with a stale entry is a discard.
  test('a stale chunk entry leaves a discard as a discard', () => {
    expect(
      classifyReloadCause({
        discarded: true,
        navigationType: 'back_forward',
        recentChunkError: null,
        heapBeforeReload: 120_000_000,
      }),
    ).toBe('discarded');
  });

  test('an ordinary load has no cause', () => {
    expect(
      classifyReloadCause({
        discarded: false,
        navigationType: 'navigate',
        recentChunkError: null,
        heapBeforeReload: null,
      }),
    ).toBeNull();
  });
});

describe('shouldReportReloadCause', () => {
  // REGRESSION (KRTX-239): prod pattern `1a5fb2e7…` was 46 of 47 occurrences
  // `discarded: true` / `back_forward` / low heap. A browser tab discard is
  // routine background reclaim, not an app defect — it must not page Sentry.
  test('does NOT report a browser tab discard', () => {
    expect(shouldReportReloadCause('discarded')).toBe(false);
  });

  test('reports a chunk that failed before the reload (stale deploy)', () => {
    expect(shouldReportReloadCause('chunk-error')).toBe(true);
  });

  test('reports a renderer killed under heap pressure', () => {
    expect(shouldReportReloadCause('renderer-oom')).toBe(true);
  });

  test('reports nothing for an ordinary load', () => {
    expect(shouldReportReloadCause(null)).toBe(false);
  });
});
