import { createHmac } from 'node:crypto';
import { enrichSalesEvent } from './sales-event';

export function salesHeaders(body: string, secret: string, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    'Content-Type': 'application/json',
    'X-Kortix-Timestamp': timestamp,
    'X-Kortix-Signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
  };
}

export const SALES_MAX_ATTEMPTS = 20;
export function salesRetryDelay(attempt: number): number {
  return Math.min(86_400_000, 30_000 * 2 ** (attempt - 1));
}

export async function deliverSalesEvent(
  payload: Record<string, unknown>, url: string, secret: string,
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<string | null> {
  const body = JSON.stringify(enrichSalesEvent(payload));
  try {
    const response = await send(url, {
      method: 'POST', body, headers: salesHeaders(body, secret),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? null : `HTTP ${response.status}`;
  } catch {
    // Never persist receiver bodies, credentials or user data in delivery errors.
    return 'Network error';
  }
}
