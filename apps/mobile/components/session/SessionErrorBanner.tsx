/**
 * SessionErrorBanner — renders a session turn's error text.
 *
 * Mirrors apps/web/src/components/session/session-error-banner.tsx, adapted
 * for React Native. Mobile intentionally does NOT expose billing UI, so the
 * insufficient-credits variant is informational only — it formats the error
 * nicely but has no Buy / Auto-top-up buttons (billing is web-only).
 */

import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CircleAlert, CreditCard } from 'lucide-react-native';

// ── Detection helpers ──────────────────────────────────────────────────────

/**
 * Detect the upstream 402 "Insufficient credits" surfaced from
 * /v1/router/chat/completions. Matches the same patterns the web uses so the
 * mobile and web banners trigger on the same error strings.
 */
export function isInsufficientCreditsError(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('insufficient credits') ||
    (lower.includes('payment required') && lower.includes('credit')) ||
    (lower.includes('402') && lower.includes('credit'))
  );
}

/** Extract `Balance: $-0.06` style amounts from the error text, if present. */
export function parseBalance(text: string): string | null {
  const match = text.match(/balance:\s*\$?(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  return `$${value.toFixed(2)}`;
}

// ── Insufficient-credits card ──────────────────────────────────────────────

function InsufficientCreditsCard({
  errorText,
  isDark,
}: {
  errorText: string;
  isDark: boolean;
}) {
  const balance = parseBalance(errorText);
  const message = balance
    ? `Your balance is ${balance}. Top up on kortix.com to continue.`
    : 'Top up on kortix.com to continue.';

  return (
    <View
      style={{
        marginTop: 8,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: isDark ? 'rgba(245, 158, 11, 0.3)' : 'rgba(245, 158, 11, 0.3)',
        backgroundColor: isDark ? 'rgba(245, 158, 11, 0.08)' : 'rgba(245, 158, 11, 0.05)',
      }}
    >
      <Icon
        as={CreditCard}
        size={14}
        style={{ marginTop: 2, color: isDark ? '#f59e0b' : '#d97706' }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          className="text-xs font-roobert-medium text-foreground"
          style={{ lineHeight: 16 }}
        >
          You ran out of credits
        </Text>
        <Text
          className="text-[11px] text-muted-foreground"
          style={{ lineHeight: 15, marginTop: 2 }}
        >
          {message}
        </Text>
      </View>
    </View>
  );
}

// ── Generic error card ─────────────────────────────────────────────────────

function GenericErrorCard({ errorText }: { errorText: string }) {
  return (
    <View className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 flex-row items-start gap-2">
      <Icon as={CircleAlert} size={14} className="text-destructive" style={{ marginTop: 2 }} />
      <Text className="text-sm text-destructive flex-1" style={{ lineHeight: 18 }}>
        {errorText}
      </Text>
    </View>
  );
}

// ── Public component ───────────────────────────────────────────────────────

export interface SessionErrorBannerProps {
  errorText: string;
  isDark: boolean;
}

/**
 * Render a session-turn error. Specialized card for insufficient-credits;
 * plain destructive card otherwise.
 */
export function SessionErrorBanner({ errorText, isDark }: SessionErrorBannerProps) {
  if (!errorText) return null;
  if (isInsufficientCreditsError(errorText)) {
    return <InsufficientCreditsCard errorText={errorText} isDark={isDark} />;
  }
  return <GenericErrorCard errorText={errorText} />;
}
