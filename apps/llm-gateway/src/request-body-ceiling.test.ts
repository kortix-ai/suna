import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_REQUEST_BYTES } from '@kortix/llm-gateway';
import {
  BUN_DEFAULT_MAX_REQUEST_BODY_BYTES,
  bunRequestBodyCeilingBytes,
} from './request-body-ceiling';

describe('bunRequestBodyCeilingBytes', () => {
  test("sits strictly above the per-request cap so the pipeline 413 fires, not Bun's", () => {
    // Essentia 2026-08-25: DEFAULT_MAX_REQUEST_BYTES === Bun's default, so a
    // 129 MiB body was refused by Bun with no log line.
    expect(DEFAULT_MAX_REQUEST_BYTES).toBe(BUN_DEFAULT_MAX_REQUEST_BODY_BYTES);
    expect(bunRequestBodyCeilingBytes(DEFAULT_MAX_REQUEST_BYTES)).toBeGreaterThan(
      DEFAULT_MAX_REQUEST_BYTES,
    );
  });

  test("stays above Bun's default even for a small clamped cap", () => {
    expect(bunRequestBodyCeilingBytes(42 * 1024 * 1024)).toBeGreaterThan(
      BUN_DEFAULT_MAX_REQUEST_BODY_BYTES,
    );
  });

  test('a disabled cap (0) still yields a finite ceiling', () => {
    const ceiling = bunRequestBodyCeilingBytes(0);
    expect(Number.isFinite(ceiling)).toBe(true);
    expect(ceiling).toBeGreaterThan(BUN_DEFAULT_MAX_REQUEST_BODY_BYTES);
  });
});
