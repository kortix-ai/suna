import { DEFAULT_IMAGE_WINDOW, DEFAULT_MAX_REQUEST_BYTES } from '@kortix/llm-gateway';
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
  // The API inside the VPC (plaintext, e.g. http://api.<stack>.internal:8008).
  // Unset = every call uses KORTIX_API_URL. See createApiClient.
  apiInternalUrl: process.env.KORTIX_API_INTERNAL_URL || undefined,
  apiToken: requiredApiToken(),
  internalEdgeKey: process.env.KORTIX_INTERNAL_EDGE_KEY || undefined,
  // Requests per minute per credential on every model route (token-rate-limit.ts).
  // The same setting as the API's /v1/llm limit, so one value covers both paths.
  // A value of 0 or less falls back to 600, as in the API.
  requestsPerMinutePerCredential: optionalInt('KORTIX_LLM_GATEWAY_REQS_PER_MIN', 600) > 0
    ? optionalInt('KORTIX_LLM_GATEWAY_REQS_PER_MIN', 600)
    : 600,
  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST,
  },
  // Default: 128 MiB (DEFAULT_MAX_REQUEST_BYTES). A declared body over this is
  // refused with 413 before a byte is read. 0 disables the per-request cap.
  maxRequestBytes: optionalInt('GATEWAY_MAX_REQUEST_BYTES', DEFAULT_MAX_REQUEST_BYTES),
  // Inline-image cap per request (see @kortix/llm-gateway pipeline/image-window.ts).
  // Count: default 20 (a choice: Bedrock accepts 600); on overflow 13 images survive.
  // Bytes: default 22 MiB of base64 images (Bedrock and Anthropic refuse a ~32 MB
  // body); on overflow 16 MiB survive. 0 disables either cap.
  // Anthropic's origin for Claude Code's model calls on Claude accounts
  // (@kortix/llm-gateway claude-code/passthrough.ts). A test points it at a
  // local stand-in.
  claudeCodeUpstream: process.env.CLAUDE_CODE_UPSTREAM_URL || 'https://api.anthropic.com',
  imageWindow: {
    maxImages: optionalInt('GATEWAY_MAX_INLINE_IMAGES', DEFAULT_IMAGE_WINDOW.maxImages),
    keepOnOverflow: optionalInt(
      'GATEWAY_IMAGE_KEEP_ON_OVERFLOW',
      DEFAULT_IMAGE_WINDOW.keepOnOverflow,
    ),
    maxBytes: optionalInt('GATEWAY_MAX_INLINE_IMAGE_BYTES', DEFAULT_IMAGE_WINDOW.maxBytes ?? 0),
    keepBytesOnOverflow: optionalInt(
      'GATEWAY_IMAGE_KEEP_BYTES_ON_OVERFLOW',
      DEFAULT_IMAGE_WINDOW.keepBytesOnOverflow ?? 0,
    ),
  },
};
