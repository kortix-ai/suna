import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  GIT_MIRROR_UNAVAILABLE_CODE,
  classifyGitError,
  isTransientGitMirrorError,
} from '../projects/git/mirror';

// Regression for incident `incident-20260923T100537Z-hbcr`.
//
// The KX-HOURLY heartbeat probe's `sessions new` cold-cloned the private mirror
// of project `an internal project`. GitHub answered `fatal: repository '<url>' not found`
// (a transient credential/visibility blip — the git proxy served the same repo
// 200 seconds before and after). `classifyGitError` typed it `kind: 'failed'`,
// which the git branch of `app.onError` did not classify, so it fell through to
// the generic branch: an unhandled HTTP 500 plus a Sentry/Better Stack page.
//
// This proves the GLOBAL classification in `app.onError` now downgrades a
// transient mirror failure — including that ambiguous private-repo 404 — to a
// retryable 503 + Retry-After WITHOUT paging Sentry, while a PERMANENT failure
// (bad ref, real auth denial, corrupt local repo) still stays loud.

const INCIDENT_STDERR =
  "fatal: repository 'https://github.com/acme/private-mirror.git/' not found";

const CLONE_ARGS = ['clone', '--bare', 'https://github.com/x/y.git', '/tmp/kortix/git-cache/x.git'] as const;

function cloneError(stderr: string, extra: Record<string, unknown> = {}) {
  return classifyGitError({ stderr, code: 128, message: 'Command failed: git clone --bare', ...extra }, CLONE_ARGS, 90_000);
}

/**
 * A faithful reproduction of the production `app.onError` classification chain
 * (the relevant branches only — see apps/api/src/index.ts). Captures whether
 * `captureException` (the Sentry/Better Stack paging call) would have fired,
 * and what status + headers the client gets.
 */
function makeClassifyingOnError() {
  const captured: unknown[] = [];
  const captureException = (err: unknown) => {
    captured.push(err);
  };
  const app = new Hono();
  app.onError((err, c) => {
    if (isTransientGitMirrorError(err)) {
      c.header('Retry-After', '10');
      return c.json(
        {
          error: true,
          code: GIT_MIRROR_UNAVAILABLE_CODE,
          message: 'git mirror is temporarily unavailable',
          status: 503,
        },
        503,
      );
    }

    if (err instanceof HTTPException) {
      if (err.status >= 500) captureException(err);
      if (err.status === 503) c.header('Retry-After', '10');
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }

    captureException(err);
    return c.json({ error: true, message: 'Internal server error', status: 500 }, 500);
  });
  return { app, captured: () => captured };
}

describe('app.onError git-mirror transient classification', () => {
  it('downgrades the exact incident clone failure to 503 + Retry-After (no Sentry)', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw cloneError(INCIDENT_STDERR);
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    const body = (await res.json()) as { message: string; status: number; code: string };
    expect(body.status).toBe(503);
    expect(body.message).toBe('git mirror is temporarily unavailable');
    // The stable code is what the frontend SDK classifies as an EXPECTED,
    // retryable degradation (silent to the FRONTEND Sentry) — without it the
    // 503 body is opaque and `handleApiError` pages Better Stack (pattern
    // `b4d05df2…`). See `packages/sdk/src/core/http/api-client.ts`.
    expect(body.code).toBe(GIT_MIRROR_UNAVAILABLE_CODE);
    // The whole point: this transient failure did NOT page Sentry/Better Stack.
    expect(captured()).toHaveLength(0);
  });

  it('downgrades a mid-clone timeout to 503 + Retry-After (unchanged behaviour)', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw cloneError("Cloning into bare repository '/tmp/x.git'...", {
        killed: true,
        signal: 'SIGTERM',
      });
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(captured()).toHaveLength(0);
  });

  it('downgrades a transient network failure to 503 + Retry-After (no Sentry)', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw cloneError("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com");
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    expect(captured()).toHaveLength(0);
  });

  it('does NOT swallow a permanent git failure (bad ref) — still 500 + capture', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw cloneError("fatal: couldn't find remote ref refs/heads/nope");
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).toHaveLength(1);
  });

  it('does NOT swallow a real auth denial — still 500 + capture', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw cloneError("fatal: Authentication failed for 'https://github.com/x/y.git/'");
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).toHaveLength(1);
  });

  it('does NOT swallow a generic Error — still 500 + capture', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new Error('boom — a real bug');
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).toHaveLength(1);
  });
});
