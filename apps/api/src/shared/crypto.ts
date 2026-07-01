import { createHmac, timingSafeEqual, randomInt, scryptSync } from 'crypto';
import { sharedConfig as config } from './effect';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomAlphanumeric(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARS[randomInt(CHARS.length)]!;
  }
  return result;
}

/**
 * Kortix API key prefixes.
 *
 *   kortix_      — user-created API key (for external programmatic access)
 *   kortix_sb_   — sandbox-managed key (auto-created per sandbox, used by agents)
 *   pk_          — public key identifier (safe to store/display)
 *
 * Both secret key variants validate through the same path — only the hash is stored.
 */
export const KEY_PREFIX = 'kortix_';
export const KEY_PREFIX_SANDBOX = 'kortix_sb_';
export const KEY_PREFIX_TUNNEL = 'kortix_tnl_';
export const KEY_PREFIX_PAT = 'kortix_pat_';
export const KEY_PREFIX_SA = 'kortix_sa_';
export const KEY_PREFIX_GATEWAY = 'kortix_gw_';
export const KEY_PREFIX_PUBLIC = 'pk_';

const SECRET_RANDOM_LENGTH = 32;

/**
 * Check if a token is a Kortix-issued key (user or sandbox).
 * Single check for the router — no branching on multiple prefixes.
 */
export function isKortixToken(token: string): boolean {
  return token.startsWith(KEY_PREFIX);
}

/**
 * Generate a public/secret key pair for a user-created API key.
 * Secret key: kortix_<32 chars>  (shown once, only hash stored)
 * Public key:  pk_<32 chars>     (safe to store/display)
 */
export function generateApiKeyPair(): { publicKey: string; secretKey: string } {
  return {
    publicKey: `${KEY_PREFIX_PUBLIC}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
    secretKey: `${KEY_PREFIX}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
  };
}

/**
 * Generate a public/secret key pair for a sandbox-managed key.
 * Secret key: kortix_sb_<32 chars>  (injected as KORTIX_TOKEN into sandbox)
 * Public key: pk_<32 chars>          (safe to store/display)
 */
export function generateSandboxKeyPair(): { publicKey: string; secretKey: string } {
  return {
    publicKey: `${KEY_PREFIX_PUBLIC}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
    secretKey: `${KEY_PREFIX_SANDBOX}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
  };
}

/**
 * Generate a tunnel-specific setup token.
 * Token: kortix_tnl_<32 chars> (shown once during tunnel creation, only hash stored)
 */
export function generateTunnelToken(): string {
  return `${KEY_PREFIX_TUNNEL}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`;
}

/**
 * Generate a Personal Access Token (PAT) for the CLI.
 * Secret key: kortix_pat_<32 chars>  (shown once, only hash stored)
 * Public key: pk_<32 chars>           (safe to store/display)
 */
export function generateAccountTokenPair(): { publicKey: string; secretKey: string } {
  return {
    publicKey: `${KEY_PREFIX_PUBLIC}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
    secretKey: `${KEY_PREFIX_PAT}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}`,
  };
}

/** Check if a token is a CLI Personal Access Token. */
export function isAccountToken(token: string): boolean {
  return token.startsWith(KEY_PREFIX_PAT);
}

/**
 * Generate a project-scoped LLM gateway key for external/programmatic access.
 * Secret: kortix_gw_<32 chars>  (shown once, only the hash is stored).
 */
export function generateGatewayKeyPair(): { secretKey: string } {
  return { secretKey: `${KEY_PREFIX_GATEWAY}${randomAlphanumeric(SECRET_RANDOM_LENGTH)}` };
}

/** Check if a token is a gateway key. */
export function isGatewayKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX_GATEWAY);
}

/**
 * Generate a service-account bearer.
 * Secret: kortix_sa_<32 chars>  (shown once, only hash stored)
 * Public prefix is the first 16 chars after the prefix — used purely as
 * a display identifier in admin lists.
 */
export function generateServiceAccountSecret(): { secret: string; publicPrefix: string } {
  const body = randomAlphanumeric(SECRET_RANDOM_LENGTH);
  return {
    secret: `${KEY_PREFIX_SA}${body}`,
    publicPrefix: `${KEY_PREFIX_SA}${body.slice(0, 8)}…`,
  };
}

/** Check if a token is a service-account bearer. */
export function isServiceAccountToken(token: string): boolean {
  return token.startsWith(KEY_PREFIX_SA);
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

/**
 * Generate a human-readable device auth code: XXXX-NNNN
 * (4 uppercase letters + hyphen + 4 digits)
 */
export function generateDeviceCode(): string {
  let letters = '';
  let numbers = '';
  for (let i = 0; i < 4; i++) {
    letters += UPPER[randomInt(UPPER.length)]!;
    numbers += DIGITS[randomInt(DIGITS.length)]!;
  }
  return `${letters}-${numbers}`;
}

/** Check if a token is a tunnel setup token. */
export function isTunnelToken(token: string): boolean {
  return token.startsWith(KEY_PREFIX_TUNNEL);
}

export function hashSecretKey(secretKey: string): string {
  const secret = config.API_KEY_SECRET;
  if (!secret) {
    throw new Error('API_KEY_SECRET not configured');
  }

  return `scrypt:v1:${scryptSync(secretKey, secret, 32).toString('hex')}`;
}

function legacyHashSecretKey(secretKey: string): string {
  const secret = config.API_KEY_SECRET;
  if (!secret) {
    throw new Error('API_KEY_SECRET not configured');
  }

  return createHmac('sha256', secret)
    .update(secretKey)
    .digest('hex');
}

export function candidateSecretKeyHashes(secretKey: string): string[] {
  return [hashSecretKey(secretKey), legacyHashSecretKey(secretKey)];
}

export function verifySecretKey(secretKey: string, storedHash: string): boolean {
  try {
    const computedHash = storedHash.startsWith('scrypt:v1:')
      ? hashSecretKey(secretKey)
      : legacyHashSecretKey(secretKey);

    const storedBuffer = Buffer.from(storedHash.replace(/^scrypt:v1:/, ''), 'hex');
    const computedBuffer = Buffer.from(computedHash.replace(/^scrypt:v1:/, ''), 'hex');

    if (storedBuffer.length !== computedBuffer.length) {
      return false;
    }

    return timingSafeEqual(storedBuffer, computedBuffer);
  } catch {
    return false;
  }
}

export function isApiKeySecretConfigured(): boolean {
  return !!config.API_KEY_SECRET;
}

export function deriveSigningKey(token: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(token)
    .digest('hex');
}
