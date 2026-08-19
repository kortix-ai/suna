import { randomBytes } from 'node:crypto';
import { getRequestContext } from './request-context';

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

function parseOtelHeaders(): Record<string, string> {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  if (!raw) return {};

  const headers: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const [key, ...rest] = part.split('=');
    const name = key?.trim();
    const value = rest.join('=').trim();
    if (name && value) headers[name] = value;
  }
  return headers;
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

export function isOtelTraceExporterConfigured() {
  return Boolean(otlpTraceEndpoint());
}

export async function emitOtelSpan(input: OTelSpanInput): Promise<boolean> {
  const endpoint = otlpTraceEndpoint();
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
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...parseOtelHeaders(),
      },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch (error) {
    console.warn('[otel] span export failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
