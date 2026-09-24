/**
 * TurnErrorDisplay — a turn's failure, inline.
 *
 * Mirrors apps/web `features/session/session-error-banner.tsx`
 * (`TurnErrorDisplay`, `UsageLimitCard`, `InsufficientCreditsCard`). Routing
 * lives in `lib/session/turn-error.ts` and is unit-tested:
 * - an abort (the user pressed Stop, or a runtime respawned) renders nothing;
 * - a connector refusal renders nothing (its notice owns the remedy);
 * - out of credits → a warning card with Buy credits (Android/web only; see
 *   iOS note below);
 * - free tier / subscription / budget limit → a warning card with Upgrade plan;
 * - anything else → a red tile with the message as title, the gateway's
 *   suggestion beneath, the `provider · code · request` meta line, and the
 *   attempt chain folded.
 *
 * Billing actions on mobile: Upgrade plan opens the global upgrade sheet
 * (`useUpgradeSheetStore`, the Team offer → Plans); the credit action opens
 * `/billing`, where Buy credits hands off to web billing (no in-app purchase).
 * `EXPO_PUBLIC_BILLING_ENABLED=false` (self-hosted) hides the buttons and keeps
 * the card text. There is no "Enable auto top-up" setting — the button never
 * did anything real and is gone on every platform.
 *
 * iOS (App Store guideline 3.1.1): no Buy credits button — `canPurchase`
 * (`canShowExternalPurchase`, `lib/billing/store-policy`) is false, so the
 * card shows "You ran out of credits" plus a muted "An account owner can add
 * credits." and no buttons at all.
 *
 * `SessionErrorBanner` keeps the pre-parity call signature for existing call
 * sites and renders `TurnErrorDisplay`.
 */

import { memo } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  ErrorRow,
  GatewayAttemptFailureList,
  GatewayMetaLine,
  ItemContent,
  ItemDescription,
  ItemTitle,
  StatusTile,
} from '@/components/session/turn/error-row';
import { CreditCardIcon, LightningIcon, WarningCircleIcon } from '@/lib/icons';
import { canShowExternalPurchase } from '@/lib/billing/store-policy';
import { webSpace } from '@/lib/session/user-message';
import {
  parseBalance,
  turnErrorCard,
  turnErrorSuggestion,
  type TurnErrorInput,
} from '@/lib/session/turn-error';
import { useUpgradeSheetStore } from '@/stores/upgrade-sheet-store';

export {
  isInsufficientCreditsError,
  isUsageLimitError,
  parseBalance,
  type TurnSendErrorLike,
} from '@/lib/session/turn-error';
export { SessionRetryDisplay, useRetrySecondsLeft, type SessionRetryDisplayProps } from './session-retry-display';

/** Self-hosted builds set this to "false"; billing actions then have nowhere to go. */
const BILLING_ACTIONS_ENABLED = process.env.EXPO_PUBLIC_BILLING_ENABLED !== 'false';

/** `ROW_ACTIONS` below `sm`: its own full-width line, right-aligned, wrapping. */
function RowActions({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        width: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: webSpace(2),
      }}
    >
      {children}
    </View>
  );
}

function UsageLimitCard({ errorText, style }: { errorText: string; style?: StyleProp<ViewStyle> }) {
  const openUpgradeSheet = useUpgradeSheetStore((state) => state.openUpgradeSheet);
  return (
    <ErrorRow accessibilityRole="summary" style={style}>
      <StatusTile tone="warning" icon={LightningIcon} />
      <ItemContent gap={webSpace(1)}>
        {/* The server sentence is already the headline — no second line restating it. */}
        <ItemTitle>{errorText}</ItemTitle>
      </ItemContent>
      {BILLING_ACTIONS_ENABLED ? (
        <RowActions>
          <Button
            size="sm"
            onPress={() => openUpgradeSheet({ reason: 'subscription_required', message: errorText })}
          >
            <Icon as={LightningIcon} size={webSpace(3.5)} className="text-primary-foreground" />
            <Text>Upgrade plan</Text>
          </Button>
        </RowActions>
      ) : null}
    </ErrorRow>
  );
}

function InsufficientCreditsCard({ errorText, style }: { errorText: string; style?: StyleProp<ViewStyle> }) {
  const router = useRouter();
  const balance = parseBalance(errorText);
  // iOS never shows the button that opens web checkout (App Store
  // guideline 3.1.1) — an owner has to add credits from outside the app.
  const canPurchase = canShowExternalPurchase(Platform.OS);
  const openBilling = () => router.push('/billing');
  return (
    <ErrorRow accessibilityRole="summary" style={style}>
      <StatusTile tone="warning" icon={CreditCardIcon} />
      <ItemContent gap={webSpace(0.5)}>
        <ItemTitle>You ran out of credits</ItemTitle>
        {/* The balance is the one number the user needs; without one, the raw server text. */}
        <ItemDescription tabular={canPurchase}>
          {canPurchase ? (balance ? `Balance ${balance}` : errorText) : 'An account owner can add credits.'}
        </ItemDescription>
      </ItemContent>
      {BILLING_ACTIONS_ENABLED && canPurchase ? (
        <RowActions>
          <Button size="sm" onPress={openBilling}>
            <Icon as={LightningIcon} size={webSpace(3.5)} className="text-primary-foreground" />
            <Text>Buy credits</Text>
          </Button>
        </RowActions>
      ) : null}
    </ErrorRow>
  );
}

export interface TurnErrorDisplayProps extends TurnErrorInput {
  style?: StyleProp<ViewStyle>;
}

function TurnErrorDisplayImpl({ style, ...input }: TurnErrorDisplayProps) {
  const card = turnErrorCard(input);
  switch (card.kind) {
    case 'none':
      return null;
    case 'usage-limit':
      return <UsageLimitCard errorText={card.text} style={style} />;
    case 'credits':
      return <InsufficientCreditsCard errorText={card.text} style={style} />;
    case 'error': {
      const suggestion = turnErrorSuggestion(card.text, card.gateway);
      return (
        <ErrorRow accessibilityRole="alert" style={style}>
          <StatusTile tone="error" icon={WarningCircleIcon} hasDescription={Boolean(suggestion)} />
          <ItemContent gap={webSpace(1)}>
            <ItemTitle>{card.text}</ItemTitle>
            {suggestion ? <ItemDescription>{suggestion}</ItemDescription> : null}
            <GatewayMetaLine details={card.gateway} />
            <GatewayAttemptFailureList details={card.gateway} />
          </ItemContent>
        </ErrorRow>
      );
    }
  }
}

export const TurnErrorDisplay = memo(TurnErrorDisplayImpl);
TurnErrorDisplay.displayName = 'TurnErrorDisplay';

export interface SessionErrorBannerProps {
  errorText: string;
  /** Unused since the web-parity rebuild; theme comes from the palette. Kept for call sites. */
  isDark?: boolean;
  isAbort?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Pre-parity entry point. New code renders `TurnErrorDisplay` directly. */
export function SessionErrorBanner({ errorText, isAbort, style }: SessionErrorBannerProps) {
  return <TurnErrorDisplay errorText={errorText} isAbort={isAbort} style={style} />;
}
