/**
 * Regression guard for the phantom-5xx signal on `POST /v1/projects/:id/sessions`.
 *
 * The request-completion middleware (`src/index.ts`) owns the top-level `status`
 * field on a log line: it is THIS API's response status. The Better Stack
 * log-anomaly sweep counts every line with `status >= 500` as a 5xx response on
 * the route the line carries. `generateViaGateway` used to log the UPSTREAM
 * gateway's status as `{ status: res.status, model }`, so a handled
 * title-generation fallback (gateway 503) was counted as a 503 response of the
 * session-create route: 282 phantom 5xx in 12 h, against 3 real ones.
 *
 * The upstream status is logged as `upstream_status`. A line with no `status`
 * field is never counted as a request.
 */
import { describe, expect, it, mock } from 'bun:test';

process.env.LLM_GATEWAY_PROXY_TARGET = 'http://127.0.0.1:59999';
process.env.SESSION_TITLE_GENERATION_ENABLED = 'true';

interface Logged {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}
const logged: Logged[] = [];
const record =
  (level: string) =>
  (message: string, context?: Record<string, unknown>): void => {
    logged.push({ level, message, context });
  };

mock.module('../lib/logger', () => ({
  logger: {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  },
  isLoggingTransportError: () => false,
}));

const { generateSessionTitleFromFirstPrompt } = await import('./session-title-generate');

// A row that still needs a title (no name / custom_name).
const row = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  metadata: { opencode_model: 'codex/gpt-6-sol' },
} as never;

describe('title-generate gateway log fields', () => {
  it('logs the upstream gateway status as upstream_status, never as the request status', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('upstream unavailable', { status: 503 })) as unknown as typeof fetch;
    try {
      await generateSessionTitleFromFirstPrompt(
        {
          sessionId: 'sess-1',
          projectId: 'proj-1',
          accountId: 'acct-1',
          userId: 'user-1',
          firstPromptText: 'Please set up the MS Graph OAuth2 connector',
        },
        {
          loadRow: async () => row,
          mintKey: async () => ({ secret: 'sk', keyId: 'key-1' }),
          revokeKey: async () => {},
          persist: async () => {},
          // No retry model: one gateway attempt, one warn.
          fallbackModel: async () => null,
          resolveLlmGatewayEnabled: async () => true,
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    const warn = logged.find((l) => l.message === '[title-generate] gateway returned non-200');
    expect(warn).toBeDefined();
    expect(warn?.context?.upstream_status).toBe(503);
    // The load-bearing assertion: without a top-level `status`, the sweep reads
    // this warn as a log line, not as a 5xx response.
    expect(warn?.context).not.toHaveProperty('status');
  });
});
