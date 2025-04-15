'use client';

import { Check, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { setupNewSubscription } from "@/lib/actions/billing";
import { createClient } from "@/lib/supabase/client";
import { useEffect, useState } from "react";

export const SUBSCRIPTION_PLANS = {
  FREE: 'price_1RDQbOG6l1KZGqIrgrYzMbnL',
  BASIC: 'price_1RC2PYG6l1KZGqIrpbzFB9Lp', // Example price ID
  PRO: 'price_1RDQWqG6l1KZGqIrChli4Ys4'
} as const;

const PLAN_DETAILS = {
  [SUBSCRIPTION_PLANS.FREE]: {
    name: 'Free',
    limit: 100,
    price: 0
  },
  [SUBSCRIPTION_PLANS.BASIC]: {
    name: 'Basic',
    limit: 100,
    price: 10
  },
  [SUBSCRIPTION_PLANS.PRO]: {
    name: 'Pro',
    limit: 100,
    price: 50
  }
} as const; 

interface PlanComparisonProps {
  accountId?: string | null;
  returnUrl?: string;
  isManaged?: boolean; // If true, uses SubmitButton, if false uses regular Button
  onPlanSelect?: (planId: string) => void;
  className?: string;
}

export function PlanComparison({
  accountId,
  returnUrl = typeof window !== 'undefined' ? window.location.href : '',
  isManaged = true,
  onPlanSelect,
  className = ""
}: PlanComparisonProps) {
  const [currentPlanId, setCurrentPlanId] = useState<string | undefined>();

  useEffect(() => {
    async function fetchCurrentPlan() {
      if (accountId) {
        const supabase = createClient();
        const { data } = await supabase
          .schema('basejump')
          .from('billing_subscriptions')
          .select('price_id')
          .eq('account_id', accountId)
          .eq('status', 'active')
          .single();
        
        // Set to FREE plan if no active subscription found, otherwise use the subscription's plan
        setCurrentPlanId(data?.price_id || SUBSCRIPTION_PLANS.FREE);
      } else {
        // Default to FREE plan if no accountId
        setCurrentPlanId(SUBSCRIPTION_PLANS.FREE);
      }
    }
    
    fetchCurrentPlan();
  }, [accountId]);

  return (
    <div className={`grid grid-cols-3 gap-4 ${className}`}>
      {Object.entries(PLAN_DETAILS).map(([planId, plan]) => {
        const isCurrentPlan = currentPlanId === planId;
        const isRecommended = planId === SUBSCRIPTION_PLANS.BASIC;
        
        return (
          <div 
            key={planId}
            className={`relative rounded-xl p-4 border-2 transition-all ${
              isCurrentPlan 
                ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/10' 
                : isRecommended
                ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-900/10'
                : 'border-border'
            }`}
          >
            {isRecommended && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-indigo-500 text-white px-3 py-1 rounded-full text-xs font-medium">
                Recommended
              </div>
            )}
            {isCurrentPlan && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-500 text-white px-3 py-1 rounded-full text-xs font-medium">
                Current Plan
              </div>
            )}
            
            <div className="text-center mb-4">
              <h3 className="text-lg font-semibold mb-1">{plan.name}</h3>
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-2xl font-bold">${plan.price}</span>
                <span className="text-muted-foreground">/mo</span>
              </div>
            </div>
            
            <div className="space-y-2 mb-4">
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                <span className="text-sm">{plan.limit} hours/month</span>
              </div>
              {/* Add more features as needed */}
            </div>

            {!isCurrentPlan && accountId && (
              <form>
                <input type="hidden" name="accountId" value={accountId} />
                <input type="hidden" name="returnUrl" value={returnUrl} />
                <input type="hidden" name="planId" value={planId} />
                {isManaged ? (
                  <SubmitButton 
                    pendingText="Loading..." 
                    formAction={setupNewSubscription}
                    className={`w-full ${
                      isRecommended 
                        ? 'bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white shadow-lg hover:shadow-xl'
                        : ''
                    }`}
                    variant={isRecommended ? 'default' : 'outline'}
                  >
                    {isRecommended ? (
                      <>
                        <CreditCard className="mr-2 h-4 w-4" />
                        Upgrade Now
                      </>
                    ) : (
                      'Select Plan'
                    )}
                  </SubmitButton>
                ) : (
                  <Button 
                    className={`w-full ${
                      isRecommended 
                        ? 'bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white shadow-lg hover:shadow-xl'
                        : ''
                    }`}
                    variant={isRecommended ? 'default' : 'outline'}
                    onClick={() => onPlanSelect?.(planId)}
                  >
                    {isRecommended ? (
                      <>
                        <CreditCard className="mr-2 h-4 w-4" />
                        Upgrade Now
                      </>
                    ) : (
                      'Select Plan'
                    )}
                  </Button>
                )}
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
} 