import { DEFAULT_MAX_REQUEST_BYTES } from '@kortix/llm-gateway';
import { hydrateEnvironmentSecret } from '@kortix/shared';

hydrateEnvironmentSecret();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function requiredApiToken(): string {
  const value = process.env.GATEWAY_INTERNAL_TOKEN || process.env.GATEWAY_API_TOKEN;
  if (!value) throw new Error('GATEWAY_INTERNAL_TOKEN (or GATEWAY_API_TOKEN) is required');
  return value;
}

export const config = {
  port: optionalInt('PORT', 8090),
  apiUrl: required('KORTIX_API_URL'),
  apiToken: requiredApiToken(),
  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST,
  },
  // Default: 8 MiB. This accepts the measured 2,023,225-byte Aster request and
  // rejects accidental/untrusted oversized payloads before upstream dispatch.
  maxRequestBytes: optionalInt('GATEWAY_MAX_REQUEST_BYTES', DEFAULT_MAX_REQUEST_BYTES),
};
