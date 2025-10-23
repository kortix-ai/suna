# Billing Guard System

## Overview

The mobile app now includes an automatic billing guard system that continuously monitors the user's subscription status and displays a modal when they need to subscribe or their trial has expired.

## Components

### BillingGuard

A persistent component that monitors billing status and displays the billing modal when needed.

**Location:** `components/billing/BillingGuard.tsx`

**Features:**
- Monitors billing status in real-time
- Shows modal when user has no active subscription or trial
- Periodic billing checks every 5 minutes
- Automatically skips checks on auth, billing, and onboarding screens
- Logs all billing state changes for debugging

**Usage:**
```tsx
// Already integrated in _layout.tsx
<BillingGuard />
```

### BillingModal

A full-screen modal that displays pricing options and handles subscription flows.

**Location:** `components/billing/BillingModal.tsx`

**Features:**
- Displays free trial option if available
- Shows all pricing tiers with monthly/yearly toggle
- Handles trial activation and plan checkout
- Auto-dismisses when subscription is active
- Can be made non-dismissible for forced subscription (e.g., expired trial)

**Props:**
```tsx
interface BillingModalProps {
  visible: boolean;
  onDismiss: () => void;
  canDismiss?: boolean; // If false, user must subscribe
}
```

## BillingContext Updates

The `BillingContext` now includes computed states for easier access:

```tsx
const {
  hasActiveSubscription,  // true if user has paid subscription
  hasActiveTrial,         // true if user has active trial
  needsSubscription,      // true if user needs to subscribe
} = useBillingContext();
```

## How It Works

1. **Initial Load**: The splash screen (`app/index.tsx`) routes users based on their billing status
2. **Continuous Monitoring**: The `BillingGuard` component monitors billing status while the user uses the app
3. **Modal Display**: When the user's subscription expires or credits run out, the modal automatically appears
4. **Periodic Checks**: Every 5 minutes, the billing status is refreshed to catch any changes
5. **Screen Exclusions**: The guard skips checks on auth, billing, onboarding, and splash screens

## Configuration

The billing guard automatically checks billing status based on the following conditions:

### When Modal is Shown
- User is authenticated
- User is NOT in auth, billing, onboarding, or splash screens
- User has NO active subscription
- User has NO active trial

### When Modal is Dismissible
- User can start a free trial (modal can be dismissed, user can explore)
- If no trial available, modal is NOT dismissible (user must subscribe)

## Integration

The billing guard is already integrated into the app layout:

```tsx
// app/_layout.tsx
<AuthProtection>
  <Stack>
    {/* ... routes ... */}
  </Stack>
  <BillingGuard /> {/* Monitors billing status */}
</AuthProtection>
```

## Logging

All billing checks are logged with emoji prefixes for easy debugging:

- 💳 Billing check initiated
- ✅ Billing check passed
- ❌ Billing check failed
- 🔄 Periodic check or refetch

## Testing

To test the billing guard:

1. **With Trial Available**: Log in with a new user → should see trial option in modal
2. **Trial Expired**: Log in with user who has expired trial → should see non-dismissible subscription modal
3. **Active Subscription**: Log in with subscribed user → should see no modal
4. **Subscription Expires**: Wait for subscription to expire → modal should appear automatically

## Notes

- The modal uses the same pricing data and checkout flows as the full billing screens
- All checkout operations use the existing `lib/billing/checkout.ts` functions
- The modal properly handles success/cancel callbacks from the checkout flows
- The guard respects the existing routing logic and doesn't interfere with initial splash/onboarding flows

