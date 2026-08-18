import { spawn } from 'child_process';
import { hostname, platform } from 'os';
import { isTunnelCapability } from '../shared/permissions';
import type { TunnelCapability } from '../shared/types';

/**
 * The device authorization protocol, with no terminal output of its own.
 *
 * Keeping parsing and polling separate from presentation means the validation
 * rules below can be read — and tested — without a CLI around them.
 */

const TUNNEL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETUP_TOKEN_PATTERN = /^kortix_tnl_[A-Za-z0-9_-]{32,64}$/;
const DEVICE_CODE_PATTERN = /^[A-Z]{4}-[0-9]{4}$/;
const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9]{32}$/;
const MAX_CHALLENGE_LIFETIME_MS = 10 * 60_000;

export interface DeviceAuthChallenge {
  deviceCode: string;
  deviceSecret: string;
  verificationUrl: string;
  expiresAt: string;
  pollIntervalMs: number;
}

export type DeviceAuthOutcome =
  | { status: 'approved'; tunnelId: string; token: string; capabilities: TunnelCapability[] }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved-without-token' };

export class InvalidDeviceAuthResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDeviceAuthResponseError';
  }
}

function invalid(what: string): never {
  throw new InvalidDeviceAuthResponseError(`Authorization server returned an invalid ${what}`);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

/** Only the approval URL is opened, and only after it passes this check. */
function assertSafeVerificationUrl(value: string): string {
  if (value.length > 2048) invalid('verification URL');
  const browserUrl = normalizeBrowserUrl(value);
  if (!browserUrl) invalid('verification URL');

  const url = new URL(browserUrl);
  if (url.username || url.password || (url.protocol !== 'https:' && !isLoopback(url))) {
    throw new InvalidDeviceAuthResponseError(
      'Authorization server returned an unsafe verification URL',
    );
  }
  return browserUrl;
}

export function parseDeviceAuthChallenge(value: unknown): DeviceAuthChallenge {
  if (!isJsonRecord(value)) invalid('challenge');
  const { deviceCode, deviceSecret, verificationUrl, expiresAt, pollIntervalMs } = value;

  if (typeof deviceCode !== 'string' || !DEVICE_CODE_PATTERN.test(deviceCode)) invalid('device code');
  if (typeof deviceSecret !== 'string' || !DEVICE_SECRET_PATTERN.test(deviceSecret)) {
    invalid('device secret');
  }
  if (typeof verificationUrl !== 'string') invalid('verification URL');
  if (typeof expiresAt !== 'string') invalid('expiration');

  const expiresAtMs = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + MAX_CHALLENGE_LIFETIME_MS) {
    invalid('expiration');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || (pollIntervalMs as number) < 250 || (pollIntervalMs as number) > 10_000) {
    invalid('poll interval');
  }

  return {
    deviceCode,
    deviceSecret,
    verificationUrl: assertSafeVerificationUrl(verificationUrl),
    expiresAt,
    pollIntervalMs: pollIntervalMs as number,
  };
}

function parseApprovedCredentials(value: Record<string, unknown>): { tunnelId: string; token: string } {
  const { tunnelId, token } = value;
  if (typeof tunnelId !== 'string' || !TUNNEL_ID_PATTERN.test(tunnelId)) invalid('tunnel ID');
  if (typeof token !== 'string' || !SETUP_TOKEN_PATTERN.test(token)) invalid('setup token');
  return { tunnelId, token };
}

/** The browser-approved set, deduplicated and narrowed to capabilities we support. */
function parseApprovedCapabilities(value: unknown): TunnelCapability[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value)].filter((item): item is TunnelCapability => isTunnelCapability(item));
}

export function parseDeviceAuthStatus(value: unknown): DeviceAuthOutcome | null {
  if (!isJsonRecord(value) || typeof value.status !== 'string') invalid('status response');

  switch (value.status) {
    case 'approved': {
      if (!value.tunnelId || !value.token) return { status: 'approved-without-token' };
      return {
        status: 'approved',
        ...parseApprovedCredentials(value),
        capabilities: parseApprovedCapabilities(value.capabilities),
      };
    }
    case 'denied':
      return { status: 'denied' };
    case 'expired':
      return { status: 'expired' };
    default:
      // Still pending: the caller keeps polling.
      return null;
  }
}

export async function requestDeviceAuthorization(apiUrl: string): Promise<DeviceAuthChallenge> {
  const response = await fetch(`${apiUrl}/device-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machineHostname: hostname() }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new InvalidDeviceAuthResponseError(
      `Failed to create device auth request: ${response.status} ${body.slice(0, 200)}`,
    );
  }
  return parseDeviceAuthChallenge(await response.json());
}

/**
 * Polls until the request is decided or the challenge expires.
 *
 * `onWaiting` receives the seconds left so the caller owns every rendered byte.
 * Transport errors are swallowed and retried; only a malformed response, which
 * means the server is not speaking the protocol, aborts.
 */
export async function awaitDeviceAuthorization(
  apiUrl: string,
  challenge: DeviceAuthChallenge,
  options: { onWaiting?: (secondsRemaining: number) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeviceAuthOutcome> {
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const expiresAtMs = Date.parse(challenge.expiresAt);

  for (;;) {
    const secondsRemaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
    if (secondsRemaining <= 0) return { status: 'expired' };
    options.onWaiting?.(secondsRemaining);

    let payload: unknown;
    try {
      const response = await fetch(`${apiUrl}/device-auth/${challenge.deviceCode}/status`, {
        headers: { Authorization: `Bearer ${challenge.deviceSecret}` },
      });
      if (!response.ok) {
        await wait(challenge.pollIntervalMs);
        continue;
      }
      payload = await response.json();
    } catch {
      await wait(challenge.pollIntervalMs);
      continue;
    }

    const outcome = parseDeviceAuthStatus(payload);
    if (outcome) return outcome;
    await wait(challenge.pollIntervalMs);
  }
}

export function openBrowser(url: string): void {
  if (process.env.KORTIX_AGENT_TUNNEL_NO_BROWSER === '1') return;
  const safeUrl = normalizeBrowserUrl(url);
  if (!safeUrl) return;

  const opener: Record<string, [string, string[]]> = {
    darwin: ['open', [safeUrl]],
    win32: ['rundll32.exe', ['url.dll,FileProtocolHandler', safeUrl]],
  };
  const [command, args] = opener[platform()] ?? ['xdg-open', [safeUrl]];

  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // An unopenable browser is not fatal: the URL is printed too.
  }
}
