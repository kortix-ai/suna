/**
 * Platinum API client (our own Cloud Hypervisor microVM sandbox platform).
 *
 * Thin fetch wrapper — Platinum is a plain REST API (Bearer pt_live_… key),
 * so unlike Daytona there's no SDK. Every call goes through platinumJson()
 * which adds auth + base URL and surfaces non-2xx as errors with the body.
 */

import { config } from '../config';

export function isPlatinumConfigured(): boolean {
  return !!config.PLATINUM_API_KEY;
}

function platinumBase(): string {
  const url = config.PLATINUM_SERVER_URL;
  if (!url) throw new Error('Missing PLATINUM_SERVER_URL');
  return url.replace(/\/+$/, '');
}

export async function platinumFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!config.PLATINUM_API_KEY) throw new Error('Missing PLATINUM_API_KEY');
  return fetch(`${platinumBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.PLATINUM_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/** GET/POST JSON. Throws `platinum <method> <path> -> <status> <body>` on non-2xx. */
export async function platinumJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await platinumFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`platinum ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}
