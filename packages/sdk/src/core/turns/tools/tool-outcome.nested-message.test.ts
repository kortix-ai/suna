import { describe, expect, test } from 'bun:test';
import { parseJsonFailure } from './tool-outcome';

// KRTX-3022: a failed web search read `432 Error: {"detail":{"error":"…"}}`,
// raw JSON included, because only a top-level `message` was lifted out.
const failure = (error: string) => parseJsonFailure(JSON.stringify({ success: false, error }));

describe('the nested message of a failure', () => {
  test("Tavily's `detail.error` becomes the message, and the leading status is kept", () => {
    const parsed = failure(
      'Error: 432 Error: {"detail":{"error":"This request exceeds your plan\'s set usage limit."}}',
    );
    expect(parsed?.nestedMessage).toBe("This request exceeds your plan's set usage limit.");
    expect(parsed?.status).toBe(432);
  });

  test("Kortix's own `tool_unavailable` answer reads its `message`, not its code", () => {
    const parsed = failure(
      'Error: 503 Error: {"error":"tool_unavailable","service":"tavily","upstream_status":432,"message":"Web search is unavailable right now."}',
    );
    expect(parsed?.nestedMessage).toBe('Web search is unavailable right now.');
    expect(parsed?.status).toBe(503);
  });

  test('`error.message` and a string `detail` are messages too', () => {
    expect(failure('Error: 400 Error: {"error":{"message":"Bad query"}}')?.nestedMessage).toBe('Bad query');
    expect(failure('Error: 404 Error: {"detail":"Not found"}')?.nestedMessage).toBe('Not found');
  });

  test('the existing shapes are unchanged: `message`, a JSON `status`, the `error: true` flag', () => {
    const parsed = failure('Request failed: {"error":true,"message":"Internal","status":500}');
    expect(parsed?.nestedMessage).toBe('Internal');
    expect(parsed?.status).toBe(500);
    expect(parsed?.nestedError).toBe(true);
  });

  test('a summary that only starts with a number is not a status', () => {
    expect(failure('404 files were skipped')?.status).toBeUndefined();
    expect(failure('Error: 3 tries failed')?.status).toBeUndefined();
  });
});
