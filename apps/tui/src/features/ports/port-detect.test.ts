import { describe, expect, test } from 'bun:test';

import { detectForwardablePorts, isForwardablePort } from './port-detect.ts';

describe('detectForwardablePorts', () => {
  test('a full localhost URL', () => {
    expect(detectForwardablePorts('Website is live at http://localhost:3000')).toEqual([3000]);
  });

  test('a bare 127.0.0.1:port with no scheme', () => {
    expect(detectForwardablePorts('Listening on 127.0.0.1:5173')).toEqual([5173]);
  });

  test('a bare 0.0.0.0:port with no scheme', () => {
    expect(detectForwardablePorts('Serving on 0.0.0.0:8080')).toEqual([8080]);
  });

  test('a localhost URL with a path', () => {
    expect(detectForwardablePorts('open http://localhost:3000/dashboard now')).toEqual([3000]);
  });

  test('a common "Local:" dev-server banner line (Vite-style)', () => {
    const text = [
      '  VITE v5.0.0  ready in 300 ms',
      '',
      '  ➜  Local:   http://localhost:5173/',
      '  ➜  Network: use --host to expose',
    ].join('\n');
    expect(detectForwardablePorts(text)).toEqual([5173]);
  });

  test('several distinct ports in one blob, deduplicated and sorted', () => {
    const text =
      'api on http://localhost:8080, and again http://localhost:8080, web on localhost:3000';
    expect(detectForwardablePorts(text)).toEqual([3000, 8080]);
  });

  test('ignores privileged ports below 1024, except 80 and 443', () => {
    expect(detectForwardablePorts('http://localhost:22')).toEqual([]);
    expect(detectForwardablePorts('http://localhost:99')).toEqual([]);
    expect(detectForwardablePorts('http://localhost:80')).toEqual([80]);
    expect(detectForwardablePorts('http://localhost:443')).toEqual([443]);
  });

  test('ignores the OpenCode/Kortix Master control port (8000)', () => {
    expect(detectForwardablePorts('curl http://localhost:8000/global/health')).toEqual([]);
  });

  test('ignores the sandbox SSH port (22) in bare form too', () => {
    expect(detectForwardablePorts('sshd listening on 0.0.0.0:22')).toEqual([]);
  });

  test('does not false-positive on prose with no host:port shape', () => {
    expect(detectForwardablePorts('the build finished in 3000ms, all good')).toEqual([]);
  });

  test('empty and non-matching text', () => {
    expect(detectForwardablePorts('')).toEqual([]);
    expect(detectForwardablePorts('nothing to see here')).toEqual([]);
  });
});

describe('isForwardablePort', () => {
  test('rejects out-of-range and non-integer values', () => {
    expect(isForwardablePort(0)).toBe(false);
    expect(isForwardablePort(-1)).toBe(false);
    expect(isForwardablePort(65536)).toBe(false);
    expect(isForwardablePort(3000.5)).toBe(false);
  });

  test('accepts the standard web ports and any unprivileged port', () => {
    expect(isForwardablePort(80)).toBe(true);
    expect(isForwardablePort(443)).toBe(true);
    expect(isForwardablePort(1024)).toBe(true);
    expect(isForwardablePort(65535)).toBe(true);
  });

  test('rejects privileged ports other than 80/443, and the infra ports', () => {
    expect(isForwardablePort(21)).toBe(false);
    expect(isForwardablePort(22)).toBe(false);
    expect(isForwardablePort(1023)).toBe(false);
    expect(isForwardablePort(8000)).toBe(false);
  });
});
