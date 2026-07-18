import { randomBytes } from 'node:crypto';
import { getRequestContext } from './request-context';
import { safeEgressFetch } from '../shared/ssrf-guard';

type OTelSpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT';

interface OTelSpanInput {
  name: string;
  kind?: OTelSpanKind;
  startTimeMs: number;
  endTimeMs?: number;
  attributes?: Record<string, unknown>;
}

const SPAN_KIND: Record<OTelSpanKind, number> = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
};

function otlpTraceEndpoint() {
  const explicit = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (explicit) return explicit;

  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/v1/traces`;
}

/**
 * Parse the `key1=value1,key2=value2` header shape used by the standard
 * OTEL_EXPORTER_OTLP_HEADERS env var — and reused verbatim for a per-project
 * OTLP exporter config (see repositories/gateway-otel-config.ts) so operators
 * and project owners write headers in exactly the same format.
 */
export function parseHeaderString(raw: string | undefined | null): Record<string, string> {
  const trimmed = raw?.trim();
  if (!trimmed) return {};

  const headers: Record<string, string> = {};
  for (const part of trimmed.split(',')) {
    const [key, ...rest] = part.split('=');
    const name = key?.trim();
    const value = rest.join('=').trim();
    if (name && value) headers[name] = value;
  }
  return headers;
}

function parseOtelHeaders(): Record<string, string> {
  return parseHeaderString(process.env.OTEL_EXPORTER_OTLP_HEADERS);
}

function randomSpanId() {
  return randomBytes(8).toString('hex');
}

function toUnixNano(ms: number) {
  return String(BigInt(Math.round(ms)) * 1_000_000n);
}

function toOtelValue(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) return { intValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'bigint') return { intValue: value.toString() };
  return { stringValue: String(value) };
}

function toOtelAttributes(attributes: Record<string, unknown>) {
  return Object.entries(attributes)
    .map(([key, value]) => {
      const otelValue = toOtelValue(value);
      return otelValue ? { key, value: otelValue } : null;
    })
    .filter((item): item is { key: string; value: Record<string, unknown> } => Boolean(item));
}

/**
 * A caller-supplied exporter destination that wins over the operator's env
 * config for THIS span — how a per-project OTLP config (Observability tab)
 * routes gen_ai spans to a user's own Langfuse/Datadog/Honeycomb/Braintrust/etc
 * without an operator env var. `headers` REPLACES (never merges with)
 * OTEL_EXPORTER_OTLP_HEADERS: the operator's own exporter auth must never leak
 * to a project-chosen destination.
 */
export interface OtelExporterOverride {
  endpoint: string;
  headers?: Record<string, string>;
}

export function isOtelTraceExporterConfigured(override?: OtelExporterOverride | null): boolean {
  return Boolean(override?.endpoint) || Boolean(otlpTraceEndpoint());
}

export async function emitOtelSpan(
  input: OTelSpanInput,
  override?: OtelExporterOverride | null,
): Promise<boolean> {
  const endpoint = override?.endpoint || otlpTraceEndpoint();
  const ctx = getRequestContext();
  if (!endpoint || !ctx) return false;

  const spanId = input.kind === 'SERVER' ? ctx.spanId : randomSpanId();
  const parentSpanId = input.kind === 'SERVER' ? ctx.parentSpanId : ctx.spanId;
  const attributes = {
    service: 'kortix-api',
    environment: process.env.INTERNAL_KORTIX_ENV || 'dev',
    version: process.env.SANDBOX_VERSION || 'dev',
    request_id: ctx.requestId,
    method: ctx.method,
    path: ctx.path,
    user_id: ctx.userId,
    account_id: ctx.accountId,
    project_id: ctx.projectId,
    session_id: ctx.sessionId,
    sandbox_id: ctx.sandboxId,
    ...input.attributes,
  };

  const body = {
    resourceSpans: [{
      resource: {
        attributes: toOtelAttributes({
          'service.name': 'kortix-api',
          'service.version': process.env.SANDBOX_VERSION || 'dev',
          'deployment.environment': process.env.INTERNAL_KORTIX_ENV || 'dev',
        }),
      },
      scopeSpans: [{
        scope: { name: 'kortix-api' },
        spans: [{
          traceId: ctx.traceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name: input.name,
          kind: SPAN_KIND[input.kind ?? 'INTERNAL'],
          startTimeUnixNano: toUnixNano(input.startTimeMs),
          endTimeUnixNano: toUnixNano(input.endTimeMs ?? Date.now()),
          attributes: toOtelAttributes(attributes),
          status: {
            code: Number(input.attributes?.['http.status_code'] ?? 0) >= 500 ? 2 : 1,
          },
        }],
      }],
    }],
  };

  try {
    // A project-configured destination (`override`) is caller-influenced — a
    // project owner can point it anywhere — so it goes through the same SSRF
    // egress guard as audit-webhook delivery (https-only, DNS-resolved,
    // private/link-local/cloud-metadata ranges blocked, redirects
    // re-validated per hop). The operator's own env-configured endpoint is
    // trusted infrastructure config, same trust level as DATABASE_URL, and
    // keeps using a plain fetch.
    const response = override
      ? await safeEgressFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(override.headers ?? {}) },
          body: JSON.stringify(body),
        })
      : await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...parseOtelHeaders() },
          body: JSON.stringify(body),
        });
    return response.ok;
  } catch (error) {
    console.warn('[otel] span export failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
