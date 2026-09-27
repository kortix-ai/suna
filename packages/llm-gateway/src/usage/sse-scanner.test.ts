import { describe, expect, test } from 'bun:test';
import { IncrementalSseScanner } from './sse-scanner';

describe('IncrementalSseScanner terminal detection', () => {
  test('is not terminal before any data arrives', () => {
    const scanner = new IncrementalSseScanner();
    expect(scanner.isTerminal).toBe(false);
    expect(scanner.hasExplicitDone).toBe(false);
  });

  test('[DONE] marks the stream terminal and explicit-done', () => {
    const scanner = new IncrementalSseScanner();
    scanner.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    expect(scanner.isTerminal).toBe(false);
    scanner.push('data: [DONE]\n\n');
    expect(scanner.isTerminal).toBe(true);
    expect(scanner.hasExplicitDone).toBe(true);
  });

  test('a populated finish_reason marks the stream terminal, even with no [DONE]', () => {
    const scanner = new IncrementalSseScanner();
    scanner.push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n',
    );
    expect(scanner.isTerminal).toBe(true);
    expect(scanner.hasExplicitDone).toBe(true);
  });

  test('a null finish_reason on an in-flight delta is not terminal', () => {
    const scanner = new IncrementalSseScanner();
    scanner.push('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    expect(scanner.isTerminal).toBe(false);
  });

  test('an in-band error frame is terminal but not "explicit done"', () => {
    const scanner = new IncrementalSseScanner();
    scanner.push('data: {"error":{"message":"boom","code":"upstream_down"}}\n\n');
    expect(scanner.isTerminal).toBe(true);
    expect(scanner.hasExplicitDone).toBe(false);
    expect(scanner.error).toMatchObject({ message: 'boom', code: 'upstream_down' });
  });

  test('a truncated trailing data line (cut mid-JSON) never flips terminal, even after finish()', () => {
    const scanner = new IncrementalSseScanner();
    scanner.push('data: {"choices":[{"delta":{"content":"cut off mid');
    scanner.finish();
    expect(scanner.isTerminal).toBe(false);
    expect(scanner.error).toBeNull();
    expect(scanner.usage).toBeNull();
  });
});
