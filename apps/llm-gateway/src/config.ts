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
  apiToken: requiredApiToken(),
  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST,
  },
  // Default: 128 MiB (DEFAULT_MAX_REQUEST_BYTES). A declared body over this is
  // refused with 413 before a byte is read. 0 disables the per-request cap.
  maxRequestBytes: optionalInt('GATEWAY_MAX_REQUEST_BYTES', DEFAULT_MAX_REQUEST_BYTES),
  // Inline-image cap per request (see @kortix/llm-gateway pipeline/image-window.ts).
  // Default 20 (Bedrock Converse's hard limit); on overflow the 12 most recent
  // images survive. GATEWAY_MAX_INLINE_IMAGES=0 disables pruning.
  imageWindow: {
    maxImages: optionalInt('GATEWAY_MAX_INLINE_IMAGES', DEFAULT_IMAGE_WINDOW.maxImages),
    keepOnOverflow: optionalInt(
      'GATEWAY_IMAGE_KEEP_ON_OVERFLOW',
      DEFAULT_IMAGE_WINDOW.keepOnOverflow,
    ),
  },
};
