import { afterEach, expect, test } from 'bun:test';
import { createElement, useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useArtifactSelectionCapture } from './use-artifact-selection-capture';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: ReactTestRenderer | undefined;
let capture: ReturnType<typeof useArtifactSelectionCapture>;
const anchor = {
  type: 'text' as const,
  version: 'vc_exact',
  quote: 'Forecast',
  prefix: '',
  suffix: '',
  start: 0,
  end: 8,
};

function Probe() {
  const value = useArtifactSelectionCapture();
  useLayoutEffect(() => {
    capture = value;
  });
  return null;
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
});
const mount = () =>
  act(() => {
    root = create(createElement(Probe));
  });

test('capture blocks whole-Artifact submission until the exact anchor is published', () => {
  mount();
  expect(capture.status).toBe('idle');
  let finish!: () => void;
  act(() => {
    finish = capture.begin();
  });
  expect(capture.status).toBe('pending');
  expect(capture.anchor).toBeNull();
  act(() => {
    expect(capture.publish(anchor)).toBe(true);
    finish();
  });
  expect(capture.status).toBe('idle');
  expect(capture.anchor).toEqual(anchor);
});

test('a failed capture remains blocked until explicit discard or a new capture', () => {
  mount();
  let finish!: () => void;
  act(() => {
    finish = capture.begin();
  });
  act(() => finish());
  expect(capture.status).toBe('failed');
  expect(capture.publish(anchor)).toBe(false);
  act(() => capture.clear());
  expect(capture.status).toBe('idle');
  expect(capture.anchor).toBeNull();
});

test('discard rejects a late anchor and an older finisher cannot fail a newer capture', () => {
  mount();
  let first!: () => void;
  let second!: () => void;
  act(() => {
    first = capture.begin();
    capture.clear();
  });
  expect(capture.publish(anchor)).toBe(false);
  act(() => {
    second = capture.begin();
    first();
  });
  expect(capture.status).toBe('pending');
  act(() => {
    expect(capture.publish(anchor)).toBe(true);
    first();
    second();
    second();
  });
  expect(capture.status).toBe('idle');
  expect(capture.anchor).toEqual(anchor);
});

test('an older anchored submission cannot clear a new pending or ready selection', () => {
  mount();
  act(() => {
    capture.begin();
    capture.publish(anchor);
  });
  act(() => {
    capture.begin();
    capture.clear(anchor);
  });
  expect(capture.status).toBe('pending');
  const next = { ...anchor, version: 'vc_next', quote: 'New forecast' };
  act(() => {
    capture.publish(next);
    capture.clear(anchor);
  });
  expect(capture.anchor).toEqual(next);
  act(() => capture.clear(next));
  expect(capture.anchor).toBeNull();
});
