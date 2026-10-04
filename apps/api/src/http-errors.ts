import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { OpenAPIHono } from '@hono/zod-openapi';
import { BillingError } from './billing/errors';
import { logger as appLogger } from './lib/logger';
import { captureException, isSentryIgnoredError } from './lib/sentry';
import { isRequestDeadlineHTTPException } from './middleware/request-deadline';
import {
  GIT_MIRROR_UNAVAILABLE_CODE,
  isRemotePushPolicyRejection,
  pushPolicyWarning,
  transientGitMirrorCause,
} from './projects/git/mirror';
import { resolvePrefixEscape } from './sandbox-proxy/prefix-escape';
import { previewBaseDomain } from './sandbox-proxy/preview-hosts';
import { deadCredentialLogDecision, isDeadCredential } from './shared/dead-credential-log';
import { inspectDatabaseError } from './shared/database-errors';
import { isDaytonaRateLimitError } from './shared/daytona-rate-limit';
import { isDaytonaTransientProviderError } from './shared/daytona-transient';
import { isPlatinumSandboxNotRunningError } from './shared/platinum';

// The typed branch handlers keep every ladder branch verbatim (comment,
// predicate, body); the dispatcher below calls them in the original ladder
// order, so the first match still wins and the generic tail stays last.
function handleSandboxProxyAbort(err: Error, c: Context, errName: string, path: string): Response | null {
  // Suppress SSE/long-poll abort noise — these are expected timeouts on sandbox proxy,
  // not real errors. The client reconnects automatically.
  const isAbort = errName === 'DOMException' || err.name === 'AbortError';
  const isSandboxProxy = path.includes('/p/') && path.includes('/global/event');
  if (isAbort && isSandboxProxy) {
    return c.json({ error: true, message: 'Request timeout', status: 504 }, 504);
  }
  return null;
}

function handlePlatinumSandboxNotRunning(err: Error, c: Context, method: string, path: string): Response | null {
  // Platinum auto-stops idle microVMs natively; while a box is stopped, POST
  // /:id/expose answers `409 sandbox_not_running`. That is an EXPECTED,
  // transient state, not a 500 — the caller either wakes the box and retries
  // (preview proxy) or the client retries (transcript / lease-discover). It
  // must NOT page Sentry, so the typed error is classified out of
  // captureException and surfaced as a retryable 503 + Retry-After (mirroring
  // the request-deadline 503 pattern). Other Platinum failures still throw a
  // generic Error and fall through to the generic capture below. See
  // shared/platinum.ts PlatinumSandboxNotRunningError.
  if (isPlatinumSandboxNotRunningError(err)) {
    appLogger.warn(`${method} ${path} -> 503 [PlatinumSandboxNotRunningError] ${err.message}`, {
      method,
      path,
      errorType: 'PlatinumSandboxNotRunningError',
    });
    c.header('Retry-After', '10');
    return c.json({ error: true, message: 'sandbox is not running', status: 503 }, 503);
  }
  return null;
}

function handleDaytonaRateLimit(err: Error, c: Context, method: string, path: string): Response | null {
  // Daytona's org-wide throttler surfaces any HTTP 429 from the Daytona API as
  // `DaytonaRateLimitError: ThrottlerException: Too Many Requests`. That is an
  // EXPECTED, transient provider state — every Daytona call site (preview link
  // resolution, transcript / public-share reads, lease discover, reaper health,
  // env-sync fan-out, snapshot reconciliation, …) must NOT page Sentry for it.
  // Prior PRs (#3567, #4605) guarded call sites one-by-one but new paths kept
  // reintroducing the same Better Stack fingerprint (`ec26b248…`) because a
  // forgotten try/catch still let the 429 propagate here → captureException →
  // Sentry. This single classifier covers EVERY remaining + future call site:
  // it downgrades the expected Daytona 429 to a retryable 503 + Retry-After
  // WITHOUT paging Sentry (mirroring the Platinum / git-timeout / request-
  // deadline patterns). Other Daytona failures (404 missing box, 409 conflict,
  // 5xx outage, timeout, disk quota) still throw a generic error and fall
  // through to the generic capture below, so unexpected failures stay loud.
  // See shared/daytona-rate-limit.ts.
  if (isDaytonaRateLimitError(err)) {
    appLogger.warn(`${method} ${path} -> 503 [DaytonaRateLimitError] ${err.message}`, {
      method,
      path,
      errorType: 'DaytonaRateLimitError',
      errorName: err.name,
    });
    c.header('Retry-After', '10');
    return c.json(
      {
        error: true,
        message: 'sandbox provider is temporarily rate-limited',
        status: 503,
      },
      503,
    );
  }
  return null;
}

function handleTransientGitMirrorFailure(err: Error, c: Context, method: string, path: string): Response | null {
  // A bare-clone / fetch of a project's git mirror that fails for a TRANSIENT,
  // upstream reason is EXPECTED and retryable — the mirror already retries a
  // bounded number of times internally before surfacing. Two shapes:
  //   * `kind: 'timeout'` (SIGTERM mid-transfer, large repo, transient network)
  //     — previously surfaced as the opaque Better Stack pattern `8d0cffbb…`
  //     ("Cloning into bare repository '/tmp/kortix/git-cache/….git'…" — git's
  //     progress line captured on stderr before the kill, masking the cause).
  //   * `kind: 'failed'` whose message is a transient upstream failure — the
  //     network/DNS/socket class, GitHub's 5xx, and GitHub's ambiguous
  //     `fatal: repository '<url>' not found` for a PRIVATE mirror whose
  //     credential is momentarily unusable (incident
  //     `incident-20260923T100537Z-hbcr`: KX-HOURLY `sessions new` hard-failed
  //     with an unhandled 500 on exactly this, while the git proxy served the
  //     same repo 200 seconds before and after).
  // Both are classified by `isTransientGitMirrorError` into a retryable
  // 503 + Retry-After WITHOUT paging Sentry (mirroring Platinum /
  // request-deadline). A PERMANENT failure (bad ref, real auth denial, corrupt
  // local repo) still falls through to Sentry with a meaningful `fatal:`
  // message. See projects/git/mirror.ts.
  const transientGitError = transientGitMirrorCause(err);
  if (transientGitError) {
    appLogger.warn(`${method} ${path} -> 503 [GitOperationError:${transientGitError.kind}] ${transientGitError.message}`, {
      method,
      path,
      errorType: 'GitOperationError',
      gitKind: transientGitError.kind,
      gitArgs: transientGitError.gitArgs,
      signal: transientGitError.signal,
    });
    c.header('Retry-After', '10');
    return c.json(
      {
        error: true,
        // A stable code lets the SDK/frontend classify this transient 503 as
        // an EXPECTED, retryable degradation (silent to Sentry) instead of an
        // opaque `ApiError` — the API-side classification alone only de-noises
        // the API's OWN Sentry; the 503 response crosses into the FRONTEND
        // Sentry (a separate app) via `handleApiError`. See
        // `projects/git/mirror.ts`'s `GIT_MIRROR_UNAVAILABLE_CODE`.
        code: GIT_MIRROR_UNAVAILABLE_CODE,
        message: 'git mirror is temporarily unavailable',
        status: 503,
      },
      503,
    );
  }
  return null;
}

function handlePushPolicyRejection(err: Error, c: Context, method: string): Response | null {
  // A push the REMOTE rejected by policy — branch protection, repository rules,
  // a server-side hook — is a PERMANENT, user-actionable outcome: retrying the
  // same commit is rejected again and the mirror retry cannot help. It must NOT
  // page Sentry as an opaque server error (prod Better Stack pattern
  // `5e505349…`: `push declined due to repository rule violations`). This is the
  // single backstop for every commit path that lets the error propagate here;
  // the agent-config route additionally maps it to a typed 409 at the call site.
  if (isRemotePushPolicyRejection(err)) {
    const warning = pushPolicyWarning(method, err);
    appLogger.warn(warning.message, warning.fields);
    return c.json(
      {
        error: true,
        message: 'the repository rejected the push because of its branch protection or repository rules',
        status: 409,
        code: 'repository_push_rejected',
      },
      409,
    );
  }
  return null;
}

function handleDaytonaTransientProviderError(err: Error, c: Context, method: string, path: string): Response | null {
  // A transient Daytona provider gateway / connection / timeout failure is
  // EXPECTED — the upstream Daytona API (or its nginx / Cloudflare-style
  // gateway) momentarily 502/503/504-ing, a socket reset mid-call, or the
  // SDK's own bounded call timing out. The SDK surfaces these as a generic
  // `DaytonaError` whose `message` is the raw upstream response body — when
  // the gateway 502s with an HTML error page, that HTML becomes the error
  // message verbatim, which is exactly what produced the recurring Better
  // Stack pattern `e98d61f1…` (`DaytonaError` with message
  // `<html>…<h1>502 Bad Gateway</h1>…</html>`, thrown from the SDK's axios
  // response interceptor at `createDaytonaError`). The 429 throttler case
  // is owned by `shared/daytona-rate-limit.ts` (`isDaytonaRateLimitError`)
  // and is NOT matched here — this classifier is the sibling for transient
  // gateway / connection / timeout failures. It downgrades those to a
  // retryable 503 + Retry-After WITHOUT paging Sentry (mirroring the
  // Platinum / git-timeout / request-deadline patterns), so a forgotten
  // try/catch at any Daytona call site (preview-link resolution, lease
  // discover, reaper health, env-sync fan-out, snapshot reconciliation, …)
  // can no longer page Better Stack for an upstream blip. Other Daytona
  // failures (404 missing box, 409 conflict, 401/403 auth, 400 validation,
  // disk quota, unexpected 5xx with a JSON body) still throw a generic
  // error and fall through to the generic capture below, so unexpected
  // failures stay loud. See shared/daytona-transient.ts.
  if (isDaytonaTransientProviderError(err)) {
    appLogger.warn(
      `${method} ${path} -> 503 [DaytonaError:transient] ${err.message.slice(0, 200)}`,
      {
        method,
        path,
        errorType: 'DaytonaError',
        errorName: err.name,
        statusCode: (err as { statusCode?: unknown }).statusCode ?? null,
      },
    );
    c.header('Retry-After', '10');
    return c.json(
      {
        error: true,
        message: 'sandbox provider is temporarily unavailable',
        status: 503,
      },
      503,
    );
  }
  return null;
}

function handleHttpException(err: HTTPException, c: Context, method: string, path: string): Response {
    // Only capture 5xx HTTP exceptions to Sentry (4xx are expected). The
    // request-deadline 503 is an EXPECTED, typed, retryable degradation (the
    // deadline net bounding a slow request) — already logged + metriced
    // per-route and returned with Retry-After. Capturing it to Sentry produced
    // the recurring Better Stack pattern `29af03…` "Request exceeded the 25s
    // server processing deadline" (the system working as designed), so classify
    // it out. See middleware/request-deadline.ts.
    if (err.status >= 500 && !isRequestDeadlineHTTPException(err)) {
      captureException(err, { method, path, status: err.status });
    }
    // The REASON belongs in the message, not only in the structured context.
    // Better Stack groups on the message string, so `-> 403 [HTTPException]`
    // collapsed every possible denial into one unactionable bucket: 2,338
    // boot-timeline 403s over 7 days never revealed that the rejecting branch
    // was `enforceTokenProjectScope`'s default-deny (see
    // SESSION_BOUND_PLATFORM_SINKS in middleware/auth.ts). Bounded at 200 chars
    // so a long upstream message cannot shard the grouping without limit.
    const reason = (err.message ?? '').slice(0, 200);
    // SEVERITY FOLLOWS THE CAUSE. A 4xx here is the gate working: an expired
    // token, a project-scoped token refused a cross-project read, an agent
    // without `project.session.start` in its kortix.yaml. The branch above
    // already says so — only 5xx is captured to Sentry, "4xx are expected" —
    // but every one of them was still written at ERROR level.
    //
    // PROD, 24h to 2026-09-13: 288 error-level lines, of which ~123 (43%) were
    // 4xx denials of exactly that kind. Real faults were the minority of the
    // error log, which is how a real fault gets missed.
    //
    // `warn` keeps every one of them queryable and grouped on the same message
    // — the reason stays in the string, so the 403-shape work that motivated it
    // is untouched — while `level = error` goes back to meaning the platform
    // failed. Same line, same fields, same grouping; only the severity moves.
    const level = err.status >= 500 ? 'error' : 'warn';
    const line = `${method} ${path} -> ${err.status} [HTTPException]${reason ? ` ${reason}` : ''}`;
    const fields = { status: err.status, message: err.message, reason, path, method };
    // A dead-credential refusal is the one 4xx a caller can receive forever:
    // the typed body already tells it to stop (code session_token_revoked),
    // but a caller that does not read it — an in-sandbox agent CLI retrying
    // per streamed step — turns every refusal into a warn line, ~1.19M in ten
    // days across the sandbox relay routes (KRTX-1039). Rate-limit the LINE
    // (first per window per normalized key, best-effort count in `suppressed`), never
    // the response; see shared/dead-credential-log.ts. Every other HTTPException
    // keeps its per-request line.
    if (isDeadCredential(err)) {
      const { log, suppressed } = deadCredentialLogDecision(`${method} ${path.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, ':id')} ${err.status} ${reason}`, Date.now());
      if (log) appLogger.warn(line, { ...fields, suppressed });
    } else {
      appLogger[level](line, fields);
    }

    // An HTTPException built with an explicit `res` carries a machine-readable
    // body its thrower needs the CLIENT to branch on — `code:'account_mfa_required'`
    // (iam/denial-message.ts's buildDenialError, which the web app's step-up dialog
    // keys on) and `code:'impersonation_invalid'` (middleware/impersonation.ts).
    // Rebuilding a generic `{error,message,status}` body here silently threw
    // that field away, so every typed 4xx arrived at the client untyped. Honour
    // the response the thrower constructed; everything else still gets the
    // generic shape below.
    if (err.res) {
      return err.res;
    }

    const response: Record<string, unknown> = {
      error: true,
      message: err.message,
      status: err.status,
    };

    if (isRequestDeadlineHTTPException(err)) {
      response.code = err.code;
    }

    // Add Retry-After header for 503s (sandbox waking up)
    if (err.status === 503) {
      c.header('Retry-After', '10');
    }

    return c.json(response, err.status);
}

function handleDatabaseOrUnknownError(err: Error, c: Context, errName: string, method: string, path: string): Response {
  // Database / postgres.js errors — extract the useful info, not the full SQL dump
  const databaseError = inspectDatabaseError(err);
  if (databaseError) {
    // Pool-exhaustion (Supabase pooler / PgBouncer session-mode saturation on
    // the us-east-2 shadow deployment) is a TRANSIENT infra/pooler-capacity
    // class, NOT a code bug — `(EMAXCONNSESSION) max clients reached in
    // session mode - max_size: 20` fires when the `FreeTierRotation`/
    // `YearlyRotation` cron ticks + `llm-gateway` catalog loads + a user
    // `GET /v1/projects` contend for the pooler's 20-session pool. It
    // resolves when load drops. Reusing `isSentryIgnoredError` keeps the
    // classification in one place (mirrors the #4709 ignore list + the
    // #5167/#5175 Daytona transient no-capture pattern). The DIRECT
    // `captureException` below would otherwise page Sentry despite
    // `ignoreErrors` (a direct call bypasses that list); skip it but STILL
    // log + STILL 500 so the client sees the error and retries. The infra
    // follow-up (raise the shadow pooler's `pool_size` / move to transaction
    // mode) is a human-owned external action recorded in the sweep ledger.
    // Better Stack patterns 721b7efe… (API) + b38179c5… (frontend symptom).
    const databaseMessage = databaseError.causeMessage ?? databaseError.outerMessage;
    const isPoolExhaustion = isSentryIgnoredError(
      databaseError.causeName ?? databaseError.outerName,
      databaseMessage,
    );
    if (!isPoolExhaustion) {
      captureException(err, {
        method,
        path,
        errorType: 'database',
        pgCode: databaseError.pgCode,
        table: databaseError.table,
        schema: databaseError.schema,
      });
    }
    appLogger.error(
      `${method} ${path} -> 500 [DB ${databaseError.severity || 'ERROR'} ${databaseError.pgCode || '?'}]`,
      {
        method,
        path,
        errorType: isPoolExhaustion ? 'database-pool-exhaustion' : 'database',
        transient: isPoolExhaustion || undefined,
        outerErrorType: databaseError.outerName,
        causeErrorType: databaseError.causeName,
        pgCode: databaseError.pgCode,
        severity: databaseError.severity,
        table: databaseError.table,
        schema: databaseError.schema,
        hint: databaseError.hint,
        detail: databaseError.detail,
        message: databaseError.outerMessage.split('\n')[0],
        causeMessage: databaseError.causeMessage?.split('\n')[0] ?? null,
      },
    );
  } else {
    // Generic unhandled error — capture to Sentry + structured log
    captureException(err, { method, path, errorType: errName });
    appLogger.error(`${method} ${path} -> 500 [${errName}] ${err.message}`, {
      method,
      path,
      errorType: errName,
      stack: err.stack?.split('\n').slice(0, 5).join('\n'),
    });
  }

  return c.json(
    {
      error: true,
      message: 'Internal server error',
      status: 500,
    },
    500,
  );
}

// The dispatcher keeps the original head of the onError callback; each branch
// below it was extracted whole into the typed handler above it.
function handleUnhandledError(err: Error, c: Context): Response {
  const method = c.req.method;
  const path = c.req.path;
  const errName = err.constructor?.name || 'Error';
  const abort = handleSandboxProxyAbort(err, c, errName, path);
  if (abort) return abort;
  const platinum = handlePlatinumSandboxNotRunning(err, c, method, path);
  if (platinum) return platinum;
  const daytonaRateLimited = handleDaytonaRateLimit(err, c, method, path);
  if (daytonaRateLimited) return daytonaRateLimited;
  const gitUnavailable = handleTransientGitMirrorFailure(err, c, method, path);
  if (gitUnavailable) return gitUnavailable;
  const pushRejected = handlePushPolicyRejection(err, c, method);
  if (pushRejected) return pushRejected;
  const daytonaTransient = handleDaytonaTransientProviderError(err, c, method, path);
  if (daytonaTransient) return daytonaTransient;
  if (err instanceof BillingError) {
    appLogger.error(`${method} ${path} -> ${err.statusCode} [BillingError]`, {
      statusCode: err.statusCode,
      message: err.message,
      path,
      method,
    });
    return c.json({ error: err.message }, err.statusCode as any);
  }
  if (err instanceof HTTPException) {
    return handleHttpException(err, c, method, path);
  }
  return handleDatabaseOrUnknownError(err, c, errName, method, path);
}

export function installHttpErrors(app: OpenAPIHono) {
// === Error Handling ===
app.onError(handleUnhandledError);

// === 404 Handler ===
app.notFound((c) => {
  // A root-absolute link on a path-based preview (`<a href="/learn">` inside
  // /v1/p/{sandbox}/{port}/) resolves against THIS origin and lands here with
  // the prefix stripped. Put the navigation back where it belongs instead of
  // answering a JSON 404 the user can do nothing with. See prefix-escape.ts —
  // the durable fix is the per-preview origin, this only recovers navigations.
  const escaped = resolvePrefixEscape(c.req.raw);
  if (escaped) {
    // On a deployment that serves preview origins this should never fire: it
    // means a BROWSER was handed a path preview somewhere. Say so loudly rather
    // than silently repairing it — the repair is correct, the fact that it was
    // needed is not.
    if (previewBaseDomain()) {
      appLogger.warn('[preview] browser escaped a PATH preview on a deployment with origins', {
        path: c.req.path,
        location: escaped.location,
      });
    }
    return c.redirect(escaped.location, escaped.status);
  }

  return c.json(
    {
      error: true,
      message: 'Not found',
      status: 404,
    },
    404,
  );
});
}
