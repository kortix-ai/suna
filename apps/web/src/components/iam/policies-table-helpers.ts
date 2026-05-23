// Pure helpers used by policies-table.tsx. Lifted into their own
// module so we can unit-test them with bun:test (which doesn't load
// the React tree). Keep this file zero-import — no React, no client
// hooks.

import type { PolicyConditions } from '@/lib/iam-client';

/** Compact "what's gating this policy?" badge labels for the row. */
export function summariseConditions(
  conditions: PolicyConditions | undefined,
): string[] {
  if (!conditions) return [];
  const out: string[] = [];
  if (Array.isArray(conditions.ip_cidrs) && conditions.ip_cidrs.length > 0) {
    out.push(
      conditions.ip_cidrs.length === 1
        ? 'IP allowlist'
        : `IP allowlist (${conditions.ip_cidrs.length})`,
    );
  }
  if (conditions.require_mfa) out.push('MFA required');
  return out;
}

/**
 * Quick client-side CIDR validity probe. Mirrors the server's
 * assertValidCidr — the server still has the final say at write time.
 */
export function isPlausibleCidr(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  const v4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(trimmed);
  if (v4) {
    const [ip, prefix] = trimmed.split('/');
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    if (parts.some((p) => p < 0 || p > 255)) return false;
    if (prefix !== undefined) {
      const p = parseInt(prefix, 10);
      if (p < 0 || p > 32) return false;
    }
    return true;
  }
  return /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(trimmed) && trimmed.includes(':');
}

/** ISO → datetime-local string (the value attribute the input expects). */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/** Compact relative-time label for the expiry chip on row badges. */
export function formatExpiryShort(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return iso;
  if (ms < 0) return 'expired';
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h`;
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `${mins}m`;
}
