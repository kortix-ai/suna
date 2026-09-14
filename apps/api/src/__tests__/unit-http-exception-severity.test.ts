import { describe, expect, test } from 'bun:test';

/**
 * `app.onError` writes one line for every HTTPException. It used to write all
 * of them at ERROR level, including 4xx — while the branch immediately above
 * it captures only 5xx to Sentry because "4xx are expected".
 *
 * PROD, 24h to 2026-09-13: 288 error-level lines, ~123 of them 4xx denials —
 * expired tokens, project-scoped tokens refused a cross-project read, an agent
 * without `project.session.start`. Real faults were the minority of the error
 * log, which is how a real fault gets missed.
 *
 * Reading the source rather than driving the server: the branch sits inside a
 * Hono `onError` on a module whose import boots the whole API. What has to hold
 * is a rule about severity, and the rule is visible in the source.
 */
const SOURCE = await Bun.file(new URL('../index.ts', import.meta.url)).text();

function httpExceptionBranch(): string {
  const start = SOURCE.indexOf('if (err instanceof HTTPException) {');
  expect(start).toBeGreaterThan(-1);
  return SOURCE.slice(start, start + 2600);
}

describe('HTTPException log severity follows the status class', () => {
  test('severity is chosen from the status, not fixed at error', () => {
    const branch = httpExceptionBranch();
    expect(branch).toContain("const level = err.status >= 500 ? 'error' : 'warn';");
    expect(branch).toContain('appLogger[level](');
  });

  test('no unconditional appLogger.error remains on this path', () => {
    expect(httpExceptionBranch()).not.toContain('appLogger.error(\n      `${method} ${path} ->');
  });

  // The reason-in-message work that made 403s diagnosable must survive: Better
  // Stack groups on the message string, so the reason stays in it.
  test('the reason is still carried in the message, bounded', () => {
    const branch = httpExceptionBranch();
    expect(branch).toContain("const reason = (err.message ?? '').slice(0, 200);");
    expect(branch).toContain('[HTTPException]${reason ?');
  });

  test('the structured fields are unchanged, so existing queries still resolve', () => {
    const branch = httpExceptionBranch();
    // Shorthand for three of them, so match the emitted property, not a colon.
    for (const field of ['status: err.status,', 'message: err.message,', 'reason,', 'path,', 'method,']) {
      expect(branch).toContain(field);
    }
  });

  test('5xx is still captured to Sentry and 4xx still is not', () => {
    expect(httpExceptionBranch()).toContain(
      'if (err.status >= 500 && !isRequestDeadlineHTTPException(err)) {',
    );
  });
});
