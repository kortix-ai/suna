import { describe, expect, test } from 'bun:test';
import { IncrementalSseScanner } from './sse-scanner';

// REGRESSION (prod, 2026-07-20): every Codex request 400'd and the only thing
// reaching the logs was `"Bad Request"` — the scanner kept `message`/`code` and
// threw away every other field of the upstream `error` object, so nothing named
// the offending part of the request. Finding the true cause needed git
// archaeology against a deleted transport. `detail` keeps the rest verbatim.
describe('IncrementalSseScanner — error frames retain upstream detail', () => {
  test('keeps type/param alongside message and code', () => {
    const scanner = new IncrementalSseScanner();
    scanner.push(
      'data: {"error":{"message":"Bad Request","code":400,"type":"invalid_request_error","param":"store"}}\n\n',
    );
    scanner.finish();
    expect(scanner.error).toEqual({
      message: 'Bad Request',
      code: 400,
      detail: { type: 'invalid_request_error', param: 'store' },
    });
  });

  test('omits detail entirely for a plain message/code frame (unchanged shape)', () => {
    const scanner = new IncrementalSseScanner();
    scanner.push('data: {"error":{"message":"Upstream idle timeout exceeded","code":"timeout"}}\n\n');
    scanner.finish();
    expect(scanner.error).toEqual({ message: 'Upstream idle timeout exceeded', code: 'timeout' });
  });

  test('retains nested detail objects verbatim', () => {
    const scanner = new IncrementalSseScanner();
    scanner.push('data: {"error":{"message":"boom","metadata":{"provider":"codex","retry":false}}}\n\n');
    scanner.finish();
    expect(scanner.error?.detail).toEqual({ metadata: { provider: 'codex', retry: false } });
  });
});
