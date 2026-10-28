// The self-host Kortix Enterprise license key (KORTIX_LICENSE_KEY).
//
// Format: `<payload>.<signature>`, both base64url. The payload is JSON
// `{ "licensee": string, "expires_at": ISO date }`. The signature is Ed25519
// over the payload bytes, made with Kortix's private key
// (apps/api/scripts/issue-license-key.ts). A valid, unexpired key unlocks the
// Enterprise features (ee/) on every account of the deployment.
//
// The key records a Kortix Enterprise subscription. It is not the license:
// production use of ee/ needs the subscription whether or not this check runs
// (ee/LICENSE, section 3).

import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { config } from '../../config';
import type { logger as Logger } from '../../lib/logger';

const KORTIX_LICENSE_PUBLIC_KEY = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmgC6/+MxVFDXzNJagDUTyHIPLQRIFR+oorar1K/Wp9E=
-----END PUBLIC KEY-----`);

export interface EnterpriseLicense {
  licensee: string;
  expiresAt: Date;
}

/** The license a key proves, or null when the key is missing, malformed or not signed by Kortix. */
export function parseLicenseKey(
  key: string | undefined,
  publicKey: KeyObject = KORTIX_LICENSE_PUBLIC_KEY,
): EnterpriseLicense | null {
  const parts = (key ?? '').trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const payload = Buffer.from(parts[0], 'base64url');
  try {
    if (!verify(null, payload, publicKey, Buffer.from(parts[1], 'base64url'))) return null;
    const body = JSON.parse(payload.toString('utf8')) as { licensee?: unknown; expires_at?: unknown };
    const expiresAt = new Date(String(body.expires_at));
    if (typeof body.licensee !== 'string' || !body.licensee.trim() || Number.isNaN(expiresAt.getTime())) return null;
    return { licensee: body.licensee.trim(), expiresAt };
  } catch {
    return null;
  }
}

const installed = parseLicenseKey(config.KORTIX_LICENSE_KEY);

/** Whether this deployment holds a valid Enterprise license key that has not expired. */
export function enterpriseLicenseActive(now: number = Date.now()): boolean {
  return installed !== null && installed.expiresAt.getTime() > now;
}

/** One boot line that says which license state the deployment runs in. */
export function logEnterpriseLicense(log: typeof Logger): void {
  if (config.ENTERPRISE_LICENSE_AVAILABLE && !installed) {
    log.warn(
      '[license] ENTERPRISE_LICENSE_AVAILABLE is retired and unlocks nothing. Set KORTIX_LICENSE_KEY to the key Kortix issued with your Enterprise subscription.',
    );
  }
  if (!config.KORTIX_LICENSE_KEY) return;
  if (!installed) {
    log.error('[license] KORTIX_LICENSE_KEY is not a valid Kortix Enterprise license key. Enterprise features stay off.');
    return;
  }
  const context = { licensee: installed.licensee, expires_at: installed.expiresAt.toISOString() };
  if (enterpriseLicenseActive()) log.info('[license] Kortix Enterprise license active', context);
  else log.error('[license] Kortix Enterprise license expired. Enterprise features are off.', context);
}
