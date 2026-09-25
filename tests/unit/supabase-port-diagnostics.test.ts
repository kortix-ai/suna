import { describe, expect, it } from 'vitest';

import { formatPortProbe } from '../src/core/local-stack';

// `supabase start` reports only `address already in use` and the container it
// could not bind — never what already held the port. That gap is why this
// failure was diagnosed three times by inference:
//
//   2026-09-21 (×4)  stale containers from a lane that skipped its teardown
//   2026-09-21       nothing left to delete; the binding was not yet released
//   2026-09-22       the workflow sweep ran CLEAN and its warning did not fire,
//                    yet `supabase start` inside ke2e still failed on 54322
//
// The workflow guards the OUTER start. This reads the port at the INNER one.

describe('formatPortProbe', () => {
  it('names the container holding a port', () => {
    const docker = '6c7b14f57e51 supabase/kong:2.8.1 Up 4 weeks (healthy) 0.0.0.0:54321->8000/tcp';
    expect(formatPortProbe(54321, 'docker', docker)).toBe(`  54321 docker: ${docker}`);
  });

  it('drops `ss`s header row, which is printed even when nothing listens', () => {
    // A lone header would read like a holder and send the next reader chasing
    // a port that is free.
    const header = 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process';
    expect(formatPortProbe(54322, 'ss', header)).toBeNull();
  });

  it('keeps a real `ss` row underneath that header', () => {
    const out = [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'LISTEN 0      4096         0.0.0.0:54322      0.0.0.0:*    users:(("docker-proxy",pid=123,fd=4))',
    ].join('\n');
    const line = formatPortProbe(54322, 'ss', out);
    expect(line).toContain('docker-proxy');
    expect(line).not.toContain('Recv-Q');
  });

  it('joins several holders rather than reporting only the first', () => {
    expect(formatPortProbe(54323, 'docker', 'aaa image Up\nbbb image Exited')).toBe(
      '  54323 docker: aaa image Up | bbb image Exited',
    );
  });

  it('returns null for empty or whitespace output — a silent probe adds nothing', () => {
    for (const out of ['', '   ', '\n\n  \n']) {
      expect(formatPortProbe(54324, 'ss', out)).toBeNull();
    }
  });

  it('never reports a port other than the one probed', () => {
    const line = formatPortProbe(54321, 'docker', 'id img Up 0.0.0.0:54321->8000/tcp');
    expect(line!.startsWith('  54321 ')).toBe(true);
  });
});
