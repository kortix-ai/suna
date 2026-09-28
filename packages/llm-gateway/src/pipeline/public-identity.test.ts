import { expect, test } from 'bun:test';
import { publicSseLines } from './public-identity';

test('managed SSE removes upstream comments without changing completion events', () => {
  const input = ': OPENROUTER PROCESSING\n\ndata: {"model":"z-ai/glm-5.3-flash","choices":[{"delta":{"content":"ok"}}]}\n\n: provider heartbeat\r\n\r\ndata: [DONE]\n\n';
  const output = publicSseLines(input, 'glm-5.3-flash');
  expect(output).not.toContain('OPENROUTER');
  expect(output).not.toContain('provider heartbeat');
  expect(output).toContain('data: {"model":"glm-5.3-flash","choices":[{"delta":{"content":"ok"}}]}\n\n');
  expect(output).toContain('data: [DONE]\n\n');
});
