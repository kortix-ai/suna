import { createHmac } from 'node:crypto';

// Wire contract mirrored by kortix-sandbox-agent-server/src/preview-bridge.ts.
// This ticket grants ONLY a localhost app port, never daemon/control access.
export const PREVIEW_TARGET_HEADER = 'X-Kortix-Preview-Target';
export const PREVIEW_BRIDGE_HEADER = 'X-Kortix-Preview-Bridge';
export const PREVIEW_BRIDGE_PREFIX = '/__kortix_preview';
export const PREVIEW_BRIDGE_PORT = 8000;

export function signPreviewTarget(port: number, serviceKey: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !serviceKey) {
    throw new Error('A preview target requires a valid port and sandbox service key');
  }
  const payload = `${port}.${Math.floor(Date.now() / 1000) + 60}`;
  const signature = createHmac('sha256', serviceKey)
    .update(`localhost-preview:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}
