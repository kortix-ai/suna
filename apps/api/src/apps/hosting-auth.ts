import { createHash, createHmac } from 'node:crypto';

/** Derive restart-stable App supervisor credentials without storing plaintext. */
export function appControlToken(runtimeId: string, secret: string): string {
  if (!runtimeId) throw new Error('runtimeId is required');
  if (secret.length < 16) throw new Error('App control secret must contain at least 16 characters');
  return createHmac('sha256', secret)
    .update('kortix-appd-control:v1\0')
    .update(runtimeId)
    .digest('base64url');
}

export function appControlTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Authenticate API-to-origin traffic for direct managed-container origins. */
export function appOriginToken(runtimeId: string, secret: string): string {
  if (!runtimeId) throw new Error('runtimeId is required');
  if (secret.length < 16) throw new Error('App origin secret must contain at least 16 characters');
  return createHmac('sha256', secret)
    .update('kortix-app-origin:v1\0')
    .update(runtimeId)
    .digest('base64url');
}

export function appOriginTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
