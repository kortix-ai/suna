import { describe, expect, test } from 'bun:test';
import { parsePreviewRequest } from '../../src/server/preview-request';

const ids = { projectId: 'p1', sessionId: '7a1b2c3d-1111-4222-8333-944455556666' };

describe('preview request: one port and path inside the sandbox', () => {
  test('a preview port and path', () => {
    expect(parsePreviewRequest({ ...ids, preview: { port: 3000, path: '/app' } })).toEqual({ ...ids, port: 3000, path: '/app' });
    expect(parsePreviewRequest({ ...ids, preview: { port: 5173 } })).toEqual({ ...ids, port: 5173, path: '/' });
  });

  test('a sandbox-local URL becomes its port and path', () => {
    expect(parsePreviewRequest({ ...ids, targetUrl: 'http://localhost:5173/a?b=1' })).toEqual({ ...ids, port: 5173, path: '/a?b=1' });
    expect(parsePreviewRequest({ ...ids, targetUrl: 'http://127.0.0.1/' })).toEqual({ ...ids, port: 80, path: '/' });
  });

  test('anything else is refused', () => {
    expect(parsePreviewRequest({ ...ids, targetUrl: 'https://evil.example/' })).toBeNull();
    expect(parsePreviewRequest({ ...ids, targetUrl: 'file:///etc/passwd' })).toBeNull();
    expect(parsePreviewRequest({ ...ids, preview: { port: 0 } })).toBeNull();
    expect(parsePreviewRequest({ ...ids, preview: { port: 3000, path: 'no-slash' } })).toBeNull();
    expect(parsePreviewRequest({ projectId: 'p1', sessionId: 'warm', preview: { port: 3000 } })).toBeNull();
  });
});
