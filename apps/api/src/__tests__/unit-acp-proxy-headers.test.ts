import { describe, expect, test } from 'bun:test';

import { decodedResponseHeaders } from '../projects/lib/proxy-headers';

describe('ACP proxy response headers', () => {
  test('drops encoding metadata after fetch has decoded the body', () => {
    const upstream = new Response('decoded', {
      headers: {
        'content-encoding': 'zstd',
        'content-length': '123',
        'content-type': 'application/json',
      },
    });

    const headers = decodedResponseHeaders(upstream);
    expect(headers.get('content-encoding')).toBeNull();
    expect(headers.get('content-length')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
  });
});
