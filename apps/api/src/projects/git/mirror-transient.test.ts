import { describe, expect, test } from 'bun:test';
import {
  classifyGitError,
  cloneBareWithRetry,
  isTransientGitMirrorError,
} from './mirror';

// Regression for incident `incident-20260923T100537Z-hbcr` (Better Stack: Kortix
// API prod, 2026-09-23T10:06:22Z). The KX-HOURLY heartbeat probe's
// `sessions new` cold-cloned the private mirror of project `an internal project` and the
// clone failed with:
//
//   fatal: repository 'https://github.com/acme/private-mirror.git/' not found
//
// `classifyGitError` typed that as `GitOperationError` kind `'failed'` — a
// PERMANENT class — so the clone was not retried and `app.onError` let it fall
// through to an unhandled HTTP 500. The same repository was served 200 by the
// git proxy seconds before and after, so the message was a transient
// credential/visibility blip, not a missing repository.

const INCIDENT_STDERR =
  "fatal: repository 'https://github.com/acme/private-mirror.git/' not found";

const CLONE_ARGS = [
  'clone',
  '--bare',
  'https://github.com/acme/private-mirror.git',
  '/tmp/kortix/git-cache/x.git',
] as const;

/** The exact shape Node hands `classifyGitError` for the incident. */
function incidentError() {
  return classifyGitError(
    { stderr: INCIDENT_STDERR, code: 128, message: 'Command failed: git clone --bare' },
    CLONE_ARGS,
    90_000,
  );
}

describe('isTransientGitMirrorError', () => {
  test('classifies the exact incident clone failure as transient (retryable)', () => {
    const err = incidentError();
    // The raw classification is unchanged — it is still a real non-zero exit …
    expect(err.name).toBe('GitOperationError');
    expect(err.kind).toBe('failed');
    // … but the UPSTREAM cause is transient, so it must be retryable.
    expect(isTransientGitMirrorError(err)).toBe(true);
  });

  test('classifies a mid-clone timeout as transient (unchanged behaviour)', () => {
    const err = classifyGitError(
      { killed: true, signal: 'SIGTERM', stderr: "Cloning into bare repository '/tmp/x.git'...", message: 'Command failed' },
      CLONE_ARGS,
      90_000,
    );
    expect(err.kind).toBe('timeout');
    expect(isTransientGitMirrorError(err)).toBe(true);
  });

  test.each([
    ['DNS resolution failure', 'fatal: unable to access \'https://github.com/x/y.git/\': Could not resolve host: github.com'],
    ['socket reset', 'fatal: unable to access \'https://github.com/x/y.git/\': Recv failure: Connection reset by peer'],
    ['connection refused', "fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443: Connection refused"],
    ['GitHub 5xx', "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 503"],
    ['remote hung up', 'fatal: the remote end hung up unexpectedly'],
    ['RPC failure', 'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502'],
  ])('classifies a transient network/upstream failure as transient: %s', (_name, stderr) => {
    const err = classifyGitError({ stderr, code: 128, message: 'Command failed' }, CLONE_ARGS, 90_000);
    expect(isTransientGitMirrorError(err)).toBe(true);
  });

  test.each([
    ['bad ref', "fatal: couldn't find remote ref refs/heads/nope"],
    ['auth denial', "fatal: Authentication failed for 'https://github.com/x/y.git/'"],
    ['permission denied', 'Permission denied (publickey).'],
    ['corrupt local repo', 'fatal: not a git repository (or any of the parent directories): .git'],
    ['bad revision', 'fatal: bad revision \'main..nope\''],
  ])('does NOT classify a permanent failure as transient: %s', (_name, stderr) => {
    const err = classifyGitError({ stderr, code: 128, message: 'Command failed' }, CLONE_ARGS, 90_000);
    expect(err.kind).toBe('failed');
    expect(isTransientGitMirrorError(err)).toBe(false);
  });

  test('does NOT classify a non-GitOperationError as transient', () => {
    expect(isTransientGitMirrorError(new Error('repository not found'))).toBe(false);
    expect(isTransientGitMirrorError('repository not found')).toBe(false);
    expect(isTransientGitMirrorError(null)).toBe(false);
  });
});

describe('cloneBareWithRetry', () => {
  test('retries a transient failure, cleans the partial clone, then succeeds', async () => {
    let attempts = 0;
    let cleanups = 0;
    const slept: number[] = [];
    await cloneBareWithRetry({
      run: async () => {
        attempts += 1;
        if (attempts < 3) throw incidentError();
      },
      cleanup: async () => {
        cleanups += 1;
      },
      maxAttempts: 3,
      delayMs: 7,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(attempts).toBe(3);
    // The partial bare repo a failed clone leaves behind is removed on EVERY
    // failed attempt, so the next caller re-clones cleanly.
    expect(cleanups).toBe(2);
    expect(slept).toEqual([7, 7]);
  });

  test('does NOT retry a permanent failure — one attempt, then rethrow', async () => {
    let attempts = 0;
    const slept: number[] = [];
    const permanent = classifyGitError(
      { stderr: "fatal: couldn't find remote ref refs/heads/nope", code: 128, message: 'Command failed' },
      CLONE_ARGS,
      90_000,
    );
    const rejection = cloneBareWithRetry({
      run: async () => {
        attempts += 1;
        throw permanent;
      },
      cleanup: async () => {},
      maxAttempts: 3,
      delayMs: 7,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await expect(rejection).rejects.toBe(permanent);
    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
  });

  test('exhausts attempts on a persistent transient failure and rethrows the last error', async () => {
    let attempts = 0;
    let cleanups = 0;
    const last = incidentError();
    const rejection = cloneBareWithRetry({
      run: async () => {
        attempts += 1;
        throw attempts === 3 ? last : incidentError();
      },
      cleanup: async () => {
        cleanups += 1;
      },
      maxAttempts: 3,
      delayMs: 1,
      sleep: async () => {},
    });
    await expect(rejection).rejects.toBe(last);
    expect(attempts).toBe(3);
    expect(cleanups).toBe(3);
  });
});
