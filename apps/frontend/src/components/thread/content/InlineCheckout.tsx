'use client';

import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Check, Loader2, Sparkles, ArrowLeft, CreditCard, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { TierBadge } from '@/components/billing/tier-badge';
import { StripeProvider } from '@/components/billing/stripe-provider';
import { createInlineCheckout, confirmInlineCheckout } from '@/lib/api/billing';
import { usePromo } from '@/hooks/utils/use-promo';
import { useAuth } from '@/components/AuthProvider';
import { isLocalMode } from '@/lib/config';
import { useSubscriptionStore } from '@/stores/subscription-store';

type Plan = 'Plus' | 'Pro' | 'Ultra';
type BillingPeriod = 'monthly' | 'yearly';

interface PlanConfig {
  name: Plan;
  tierKey: string;
  monthlyPrice: number;
  yearlyPrice: number;
  credits: string;
  creditsNum: number; // For comparison
}

const PLANS: PlanConfig[] = [
  { name: 'Plus', tierKey: 'tier_2_20', monthlyPrice: 20, yearlyPrice: 204, credits: '2,000', creditsNum: 2000 },
  { name: 'Pro', tierKey: 'tier_6_50', monthlyPrice: 50, yearlyPrice: 510, credits: '5,000', creditsNum: 5000 },
  { name: 'Ultra', tierKey: 'tier_25_200', monthlyPrice: 200, yearlyPrice: 2040, credits: '20,000', creditsNum: 20000 },
];

// Payment Form Component (rendered inside StripeProvider)
function PaymentForm({
  selectedPlan,
  billingPeriod,
  subscriptionId,
  promoCode,
  actualAmount,
  onSuccess,
  onCancel,
}: {
  selectedPlan: PlanConfig;
  billingPeriod: BillingPeriod;
  subscriptionId: string;
  promoCode?: string;
  actualAmount?: number; // Amount in cents from Stripe (after discounts)
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use actual amount from Stripe if available (includes discounts), otherwise calculate from plan
  const basePrice = billingPeriod === 'yearly'
    ? Math.round(selectedPlan.yearlyPrice / 12)
    : selectedPlan.monthlyPrice;

  // actualAmount is in cents from Stripe - for yearly it's the full year amount
  // Convert to monthly equivalent in dollars for display
  const price = actualAmount !== undefined
    ? Math.round((actualAmount / 100) / (billingPeriod === 'yearly' ? 12 : 1))
    : basePrice;
  const hasDiscount = actualAmount !== undefined && price < basePrice;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setIsProcessing(true);
    setError(null);

    try {
      // First validate the form
      const { error: submitError } = await elements.submit();
      if (submitError) {
        setError(submitError.message || 'Please check your payment details');
        setIsProcessing(false);
        return;
      }

      // Confirm the payment
      const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/dashboard?subscription=success`,
        },
        redirect: 'if_required',
      });

      if (confirmError) {
        setError(confirmError.message || 'Payment failed');
        setIsProcessing(false);
        return;
      }

      // Payment succeeded without redirect
      if (paymentIntent?.status === 'succeeded') {
        console.log('[InlineCheckout] Payment succeeded:', {
          paymentIntentId: paymentIntent.id,
          subscriptionId,
          tierKey: selectedPlan.tierKey,
        });

        // Confirm subscription in backend to update tier immediately
        try {
          const confirmPayload = {
            subscription_id: subscriptionId,
            tier_key: selectedPlan.tierKey,
            payment_intent_id: paymentIntent.id,
          };
          console.log('[InlineCheckout] Confirming with payload:', confirmPayload);
          await confirmInlineCheckout(confirmPayload);
          console.log('[InlineCheckout] Confirmation successful');
        } catch (e: any) {
          console.error('[InlineCheckout] Confirmation failed:', e?.message || e);
        }

        onSuccess();
        // Redirect to dashboard
        window.location.href = '/dashboard?subscription=success';
      }
    } catch (err: any) {
      console.error('Payment error:', err);
      setError(err.message || 'Something went wrong');
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <div className="flex items-center gap-2">
          <TierBadge planName={selectedPlan.name} size="sm" />
          {hasDiscount ? (
            <span className="text-sm font-semibold">
              <span className="line-through text-muted-foreground">${basePrice}</span>
              {' '}
              <span className="text-green-600 dark:text-green-400">${price}/mo</span>
            </span>
          ) : (
            <span className="text-sm font-semibold">${price}/mo</span>
          )}
        </div>
      </div>

      {/* Promo reminder */}
      {promoCode && (
        <div className="flex items-center gap-2 p-2 bg-green-500/10 border border-green-500/20 rounded-lg text-xs">
          <span className="text-green-600 dark:text-green-400">
            Promo <strong>{promoCode}</strong> applied
            {hasDiscount && ` - Save $${basePrice - price}/mo`}
          </span>
        </div>
      )}

      {/* Stripe Payment Element */}
      <div className="rounded-lg border border-border p-3 bg-background">
        <PaymentElement
          options={{
            layout: 'tabs',
          }}
        />
      </div>

      {/* Error message */}
      {error && (
        <div className="p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-lg">
          {error}
        </div>
      )}

      {/* Submit button */}
      <Button
        type="submit"
        disabled={!stripe || isProcessing}
        className="w-full h-12 text-base font-medium"
        size="lg"
      >
        {isProcessing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Processing...
          </>
        ) : (
          <>
            <CreditCard className="w-4 h-4 mr-2" />
            Subscribe to {selectedPlan.name} - ${price}/mo
          </>
        )}
      </Button>

      {/* Security note */}
      <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="w-3 h-3" />
        <span>Secured by Stripe. Cancel anytime.</span>
      </div>
    </form>
  );
}

// Plan Picker Component
function PlanPicker({
  onSelectPlan,
  defaultPlan,
  defaultPeriod,
}: {
  onSelectPlan: (plan: PlanConfig, period: BillingPeriod, promoCode?: string) => Promise<void>;
  defaultPlan?: Plan;
  defaultPeriod?: BillingPeriod;
}) {
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>(defaultPeriod || 'yearly');
  const [isLoading, setIsLoading] = useState(false);
  const promo = usePromo();
  const accountState = useSubscriptionStore((state) => state.accountState);
  const [promoCode, setPromoCode] = useState(promo?.promoCode || '');
  const [showPromoInput, setShowPromoInput] = useState(false);

  // Get current tier's credits to filter available upgrade plans
  const isAccountLoaded = accountState !== null;
  const currentCredits = accountState?.tier?.monthly_credits ?? 0;

  // Only show plans that are upgrades (more credits than current tier)
  const availablePlans = PLANS.filter(plan => plan.creditsNum > currentCredits);

  // Default to specified plan if available, then Pro, then first available
  const getDefaultPlan = (): Plan => {
    if (defaultPlan && availablePlans.find(p => p.name === defaultPlan)) {
      return defaultPlan;
    }
    const proAvailable = availablePlans.find(p => p.name === 'Pro');
    if (proAvailable) return 'Pro';
    return availablePlans[0]?.name || 'Pro';
  };

  const [selectedPlan, setSelectedPlan] = useState<Plan>(getDefaultPlan());

  // Update selection if current plan is no longer available
  React.useEffect(() => {
    if (availablePlans.length > 0 && !availablePlans.find(p => p.name === selectedPlan)) {
      // Prefer defaultPlan, then Pro, otherwise first available
      if (defaultPlan && availablePlans.find(p => p.name === defaultPlan)) {
        setSelectedPlan(defaultPlan);
      } else {
        const proAvailable = availablePlans.find(p => p.name === 'Pro');
        setSelectedPlan(proAvailable ? 'Pro' : availablePlans[0].name);
      }
    }
  }, [availablePlans, selectedPlan, defaultPlan]);

  const handleContinue = async () => {
    const plan = availablePlans.find(p => p.name === selectedPlan);
    if (plan && !isLoading) {
      setIsLoading(true);
      // Small delay to ensure loading state renders before API call
      await new Promise(resolve => setTimeout(resolve, 50));
      try {
        await onSelectPlan(plan, billingPeriod, promoCode || undefined);
      } catch {
        // Error handled by parent, just reset loading
      } finally {
        setIsLoading(false);
      }
    }
  };

  // Show loading while account state loads
  if (!isAccountLoaded) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  // If user is already on highest tier, show message
  if (availablePlans.length === 0) {
    return (
      <div className="space-y-4 text-center py-4">
        <div className="flex items-center justify-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <span className="font-semibold">You're on the highest tier!</span>
        </div>
        <p className="text-sm text-muted-foreground">
          You already have access to the maximum credits available.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <span className="font-semibold">
            {currentCredits > 0 ? 'Upgrade your plan' : 'Choose your plan'}
          </span>
        </div>
        {/* Billing toggle */}
        <div className="flex items-center gap-1 text-sm bg-muted rounded-lg p-1">
          <button
            onClick={() => setBillingPeriod('monthly')}
            className={cn(
              "px-3 py-1.5 rounded-md transition-all",
              billingPeriod === 'monthly'
                ? "bg-background shadow-sm font-medium"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Monthly
          </button>
          <button
            onClick={() => setBillingPeriod('yearly')}
            className={cn(
              "px-3 py-1.5 rounded-md transition-all flex items-center gap-1",
              billingPeriod === 'yearly'
                ? "bg-background shadow-sm font-medium"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Yearly
            <span className="text-[10px] text-green-600 font-bold">-15%</span>
          </button>
        </div>
      </div>

      {/* Plan cards - dynamic grid based on available plans */}
      <div className={cn(
        "grid gap-3",
        availablePlans.length === 1 ? "grid-cols-1" :
        availablePlans.length === 2 ? "grid-cols-2" : "grid-cols-3"
      )}>
        {availablePlans.map((plan) => {
          const price = billingPeriod === 'yearly'
            ? Math.round(plan.yearlyPrice / 12)
            : plan.monthlyPrice;
          const isSelected = selectedPlan === plan.name;

          return (
            <button
              key={plan.name}
              onClick={() => setSelectedPlan(plan.name)}
              disabled={isLoading}
              className={cn(
                "relative p-3 rounded-xl border-2 transition-all text-left",
                isSelected
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50",
                isLoading && "opacity-50 cursor-not-allowed"
              )}
            >
              {isSelected && (
                <div className="absolute -top-2 -right-2 w-5 h-5 bg-primary rounded-full flex items-center justify-center">
                  <Check className="w-3 h-3 text-primary-foreground" />
                </div>
              )}
              <TierBadge planName={plan.name} size="sm" />
              <div className="mt-2">
                <span className="text-xl font-bold">${price}</span>
                <span className="text-xs text-muted-foreground">/mo</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {plan.credits} credits
              </div>
            </button>
          );
        })}
      </div>

      {/* Promo code input - only show for new subscriptions, not upgrades */}
      {currentCredits === 0 && (
        showPromoInput ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
              placeholder="Enter promo code"
              className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono"
            />
            <button
              onClick={() => setShowPromoInput(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : promoCode ? (
          <div className="flex items-center justify-between p-3 bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-xl text-sm">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-amber-600 dark:text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded">
                {promoCode}
              </span>
              <span className="text-muted-foreground">will be applied</span>
            </div>
            <button
              onClick={() => setShowPromoInput(true)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Change
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowPromoInput(true)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            + Add promo code
          </button>
        )
      )}

      {/* Continue button */}
      <Button
        onClick={handleContinue}
        disabled={isLoading}
        className="w-full h-11 text-base font-medium"
        size="lg"
      >
        {isLoading ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Loading payment form...
          </>
        ) : (
          currentCredits > 0 ? 'Continue to upgrade' : 'Continue to payment'
        )}
      </Button>
    </div>
  );
}

// Main Component
export function InlineCheckout({ options }: { options?: InlineCheckoutOptions }) {
  const { user } = useAuth();
  const promo = usePromo();
  const accountState = useSubscriptionStore((state) => state.accountState);
  const [step, setStep] = useState<'select' | 'payment' | 'loading'>('select');
  const [selectedPlan, setSelectedPlan] = useState<PlanConfig | null>(null);
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('yearly');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [appliedPromoCode, setAppliedPromoCode] = useState<string | null>(null);
  const [actualAmount, setActualAmount] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Prevent multiple subscription creations (double-click, StrictMode, etc.)
  const creatingRef = useRef(false);

  // Get current tier credits (null means still loading)
  const currentCredits = accountState?.tier?.monthly_credits ?? null;
  const isAccountLoaded = accountState !== null;

  // Get pre-selected plan from options (if specified by LLM)
  const preSelectedPlan = options?.plan
    ? (options.plan.charAt(0).toUpperCase() + options.plan.slice(1)) as Plan
    : undefined;
  const preSelectedPeriod = options?.period || 'yearly';

  if (isLocalMode()) return null;

  const handleSelectPlan = async (plan: PlanConfig, period: BillingPeriod, promoCode?: string) => {
    if (!user) {
      window.location.href = '/auth?mode=signup';
      return;
    }

    // Prevent multiple subscriptions from double-click or StrictMode
    if (creatingRef.current) {
      console.log('[InlineCheckout] Already creating subscription, skipping');
      return;
    }
    creatingRef.current = true;

    setSelectedPlan(plan);
    setBillingPeriod(period);
    // Don't clear error here - it triggers re-render that can disrupt loading state
    // Error will be replaced on new error, or cleared on success

    try {
      // Use only user-provided promo code (no auto-fallback)
      const finalPromoCode = promoCode || undefined;
      console.log('[InlineCheckout] Creating subscription for', plan.tierKey, period, finalPromoCode ? `with promo ${finalPromoCode}` : '');
      const response = await createInlineCheckout({
        tier_key: plan.tierKey,
        billing_period: period,
        promo_code: finalPromoCode,
      });

      // Handle upgrade case - payment charged to existing payment method
      if (response.upgraded) {
        console.log('[InlineCheckout] Upgraded subscription:', response.subscription_id);
        // Redirect to dashboard
        window.location.href = '/dashboard?subscription=success';
        return;
      }

      // Handle 100% discount case - no payment needed
      if (response.no_payment_required) {
        console.log('[InlineCheckout] No payment required (100% discount), subscription active:', response.subscription_id);

        // Confirm the subscription to update tier in DB
        try {
          await confirmInlineCheckout({
            subscription_id: response.subscription_id,
            tier_key: plan.tierKey,
          });
        } catch (e: any) {
          console.error('[InlineCheckout] Confirmation failed:', e?.message || e);
        }

        // Redirect to dashboard
        window.location.href = '/dashboard?subscription=success';
        return;
      }

      // Show payment form for normal checkout
      console.log('[InlineCheckout] Created subscription:', response.subscription_id, 'amount:', response.amount);
      setError(null); // Clear any previous error on success
      setClientSecret(response.client_secret!);
      setSubscriptionId(response.subscription_id);
      setAppliedPromoCode(finalPromoCode || null);
      setActualAmount(response.amount);
      setStep('payment');
    } catch (err: any) {
      console.error('Inline checkout error:', err);
      setError(err.message || 'Failed to start checkout. Please try again.');
      setStep('select');
      creatingRef.current = false; // Allow retry on error
      throw err; // Re-throw so PlanPicker can reset loading state
    }
  };

  const handleCancel = () => {
    setStep('select');
    setClientSecret(null);
    setSubscriptionId(null);
    setSelectedPlan(null);
    setAppliedPromoCode(null);
    setActualAmount(undefined);
    creatingRef.current = false; // Allow creating new subscription
  };

  const handleSuccess = () => {
    // Will redirect in PaymentForm
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-md mt-4 p-4 rounded-2xl border border-border bg-card shadow-lg"
    >
      <AnimatePresence mode="wait">
        {error && step === 'select' && (
          <motion.div
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mb-4 p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-lg"
          >
            {error}
          </motion.div>
        )}

        {step === 'select' ? (
          <motion.div
            key="select"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            <PlanPicker
              onSelectPlan={handleSelectPlan}
              defaultPlan={preSelectedPlan}
              defaultPeriod={preSelectedPeriod}
            />
          </motion.div>
        ) : clientSecret && selectedPlan && subscriptionId ? (
          <motion.div
            key="payment"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
          >
            <StripeProvider clientSecret={clientSecret}>
              <PaymentForm
                selectedPlan={selectedPlan}
                billingPeriod={billingPeriod}
                subscriptionId={subscriptionId}
                promoCode={appliedPromoCode || undefined}
                actualAmount={actualAmount}
                onSuccess={handleSuccess}
                onCancel={handleCancel}
              />
            </StripeProvider>
          </motion.div>
        ) : (
          <motion.div
            key="loading"
            className="flex items-center justify-center py-12"
          >
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// Regex to match <inline_checkout/> tags with optional plan and period attributes
const INLINE_CHECKOUT_REGEX = /<inline_checkout(?:\s+plan=["']?(plus|pro|ultra)["']?)?(?:\s+period=["']?(monthly|yearly)["']?)?\s*\/?>/gi;

export interface InlineCheckoutOptions {
  plan?: 'plus' | 'pro' | 'ultra';
  period?: 'monthly' | 'yearly';
}

/**
 * Extracts inline checkout tags from content
 */
export function extractInlineCheckout(content: string): {
  cleanContent: string;
  hasCheckout: boolean;
  options: InlineCheckoutOptions;
} {
  let hasCheckout = false;
  let options: InlineCheckoutOptions = {};

  const cleanContent = content.replace(INLINE_CHECKOUT_REGEX, (match, plan, period) => {
    hasCheckout = true;
    if (plan) options.plan = plan.toLowerCase() as 'plus' | 'pro' | 'ultra';
    if (period) options.period = period.toLowerCase() as 'monthly' | 'yearly';
    return '';
  });

  return {
    cleanContent: cleanContent.trim(),
    hasCheckout,
    options,
  };
}
