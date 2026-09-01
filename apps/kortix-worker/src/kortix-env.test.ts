import { describe, expect, test } from 'bun:test';
import {
  toExecTimeoutMs, toFileErrorCode } from './kortix-env.ts';

// The daemon's env-rpc is a thin fs proxy and reports the real errno. pi's
// tools compare against pi's OWN codes, so this client has to translate.
// Unmapped, `write` could never create a file: withFileMutationQueue
// canonicalises the target first and rethrows anything that is not
// 'not_found', so every new file died on the pre-flight lstat and the agent
// fell back to bash heredocs (observed 10x in one turn on pi.kortix.com).
describe('toFileErrorCode', () => {
  test('ENOENT becomes not_found — the code the file-mutation queue tolerates', () => {
    expect(toFileErrorCode('ENOENT')).toBe('not_found');
  });

  test('mirrors pi harness/env/nodejs.js, spellings included', () => {
    expect(toFileErrorCode('ABORT_ERR')).toBe('aborted');
    expect(toFileErrorCode('EACCES')).toBe('permission_denied');
    expect(toFileErrorCode('EPERM')).toBe('permission_denied');
    // pi spells these without the article; a tool matching 'not_a_directory'
    // would never fire.
    expect(toFileErrorCode('ENOTDIR')).toBe('not_directory');
    expect(toFileErrorCode('EISDIR')).toBe('is_directory');
    expect(toFileErrorCode('EINVAL')).toBe('invalid');
  });

  test('an unmapped errno is unknown, never passed through as an errno', () => {
    // Handing pi a raw 'EMFILE' just moves the same bug to another code path.
    expect(toFileErrorCode('EMFILE')).toBe('unknown');
    expect(toFileErrorCode('ENOSPC')).toBe('unknown');
  });

  test('a code already in pi vocabulary survives, and nothing missing throws', () => {
    expect(toFileErrorCode('not_supported')).toBe('not_supported');
    expect(toFileErrorCode(undefined)).toBe('unknown');
    expect(toFileErrorCode('')).toBe('unknown');
  });
});

/**
 * pi's `ExecutionEnvironment.exec` takes a timeout in SECONDS
 * (@earendil-works/pi-agent-core harness/types.d.ts:205 — "Timeout in
 * seconds"). The Kortix daemon reads the same field as `timeoutMs` and
 * SIGKILLs the child on it (kortix-sandbox-agent-server routes/env-rpc.ts,
 * `case 'exec'`). Forwarding the number unconverted killed every model-supplied
 * timeout ~1000x early — `bash({ timeout: 600 })` meaning ten minutes died
 * after 600ms with exit 124, and the model was told it had timed out.
 */
describe('toExecTimeoutMs', () => {
  test('converts pi seconds to daemon milliseconds', () => {
    expect(toExecTimeoutMs(600)).toBe(600_000);
    expect(toExecTimeoutMs(1)).toBe(1_000);
    expect(toExecTimeoutMs(0.5)).toBe(500);
  });

  test('leaves an unset timeout unset so the daemon applies its own default', () => {
    expect(toExecTimeoutMs(undefined)).toBeUndefined();
    expect(toExecTimeoutMs(null)).toBeUndefined();
    expect(toExecTimeoutMs('600')).toBeUndefined();
  });

  test('refuses values that would read as "kill immediately"', () => {
    // 0 forwarded as 0 is a SIGKILL before the command starts.
    expect(toExecTimeoutMs(0)).toBeUndefined();
    expect(toExecTimeoutMs(-5)).toBeUndefined();
    expect(toExecTimeoutMs(Number.NaN)).toBeUndefined();
    expect(toExecTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
