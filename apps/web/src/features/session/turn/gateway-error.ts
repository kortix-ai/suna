/**
 * Classifies an OpenCode assistant-message error (`info.error`) as a failure to
 * reach the Kortix LLM gateway from the sandbox — so the timeline renders a
 * human row instead of the raw provider string.
 *
 * THE INCIDENT (2026-08-22, evening, repeatedly). A sandbox's OpenCode is
 * configured at boot with `KORTIX_LLM_BASE_URL` derived from the API's
 * `KORTIX_URL`. When that origin dies (dev: the quick tunnel rotated and the
 * API respawned with a new one) the box keeps calling the dead URL until its
 * next prompt's env sync rewrites it. The first prompt after a rotation fails
 * inside OpenCode with APIError `Cannot connect to API: Unable to connect. Is
 * the computer able to access the url?` (or statusCode 530, message `<none>`),
 * and the transcript showed that raw string. The API side now converges the
 * URL at boot (`apps/api/src/projects/lib/gateway-url-convergence.ts`); this
 * is the UI side for the turns that still hit it.
 *
 * Pure: no React, no I/O. The row decides how to render from `kind`.
 */

export type GatewayTurnErrorKind = 'gateway-unreachable' | 'gateway-http' | 'other';

export interface GatewayTurnError {
  kind: GatewayTurnErrorKind;
  /** Human headline for the row (empty for `other`). */
  title: string;
  /** Human second line (empty for `other`). */
  detail: string;
  /** The raw provider message (or status) — kept accessible for debugging. */
  raw: string;
  statusCode?: number;
  url?: string;
}

export const GATEWAY_UNREACHABLE_TITLE = "Couldn't reach the Kortix gateway from the sandbox";
export const GATEWAY_UNREACHABLE_DETAIL =
  'The sandbox could not connect to the model gateway for this turn. It reconnects on the next message — resend to continue.';

/** OpenCode/undici wording for "the fetch never got a response". */
const CONNECT_FAILURE_RE =
  /Cannot connect to API|Unable to connect|ECONNREFUSED|ENOTFOUND|fetch failed/i;
/** The in-API gateway (`/v1/llm/...`) and the proxy-mode gateway (`/v1/llm-gateway/...`). */
const GATEWAY_PATH_RE = /\/v1\/llm(-gateway)?\//;
/** Cloudflare origin-unreachable (530) and the plain bad-gateway family. */
const UNREACHABLE_STATUSES = new Set([502, 503, 530]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalize(error: unknown): Record<string, unknown> | null {
  if (typeof error === 'string') {
    const str = error.startsWith('Error: ') ? error.slice(7) : error;
    try {
      return asRecord(JSON.parse(str));
    } catch {
      return null;
    }
  }
  return asRecord(error);
}

export function classifyGatewayTurnError(error: unknown): GatewayTurnError {
  const record = normalize(error);
  const data = asRecord(record?.data) ?? record;
  const message = typeof data?.message === 'string' ? data.message : '';
  const statusCode = typeof data?.statusCode === 'number' ? data.statusCode : undefined;
  const metadata = asRecord(data?.metadata);
  const urlRaw = metadata?.url ?? data?.url;
  const url = typeof urlRaw === 'string' ? urlRaw : undefined;
  const isGatewayUrl = url !== undefined && GATEWAY_PATH_RE.test(url);
  const trimmed = message.trim();
  const emptyMessage = trimmed === '' || trimmed === '<none>';
  const raw =
    trimmed !== '' && trimmed !== '<none>'
      ? message
      : statusCode !== undefined
        ? `HTTP ${statusCode}${trimmed ? ` ${trimmed}` : ''}`
        : typeof error === 'string'
          ? error
          : '';

  const other: GatewayTurnError = { kind: 'other', title: '', detail: '', raw, statusCode, url };
  if (!record) return other;

  // The fetch never got a response. With no url on the error the only
  // provider OpenCode talks to is the gateway; with a url it has to be ours.
  if (CONNECT_FAILURE_RE.test(message) && (url === undefined || isGatewayUrl)) {
    return {
      kind: 'gateway-unreachable',
      title: GATEWAY_UNREACHABLE_TITLE,
      detail: GATEWAY_UNREACHABLE_DETAIL,
      raw,
      statusCode,
      url,
    };
  }
  if (!isGatewayUrl) return other;

  // The edge answered for a dead origin: 530/502/503 and nothing to say.
  if (statusCode !== undefined && UNREACHABLE_STATUSES.has(statusCode) && emptyMessage) {
    return {
      kind: 'gateway-unreachable',
      title: GATEWAY_UNREACHABLE_TITLE,
      detail: GATEWAY_UNREACHABLE_DETAIL,
      raw,
      statusCode,
      url,
    };
  }
  if (statusCode !== undefined) {
    return {
      kind: 'gateway-http',
      title: `Kortix gateway returned HTTP ${statusCode}`,
      detail: emptyMessage ? '' : message,
      raw,
      statusCode,
      url,
    };
  }
  return other;
}
