import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { POST } from './route';

const warn = spyOn(console, 'warn').mockImplementation(() => {});
afterEach(() => warn.mockClear());

function report(body: unknown): Request {
  return new Request('http://localhost/api/csp-report', {
    method: 'POST',
    headers: { 'content-type': 'application/csp-report' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/csp-report', () => {
  test('logs the directive, blocked origin and first path segment only', async () => {
    const response = await POST(
      report({
        'csp-report': {
          'document-uri':
            'https://app.example.com/secret-intake/tok_abc?email=person%40example.com',
          'effective-directive': 'script-src-elem',
          'blocked-uri': 'https://cdn.example.net/x.js?k=v',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      '[csp-report]',
      { directive: 'script-src-elem', blocked: 'https://cdn.example.net', page: '/secret-intake' },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('tok_abc');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('person');
  });

  test('ignores bodies that are not CSP reports', async () => {
    const response = await POST(report({ hello: 'world' }));

    expect(response.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });
});
