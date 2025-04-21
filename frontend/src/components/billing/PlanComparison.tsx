'use client';

import { createClient } from "@/lib/supabase/client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { setupNewSubscription } from "@/lib/actions/billing";
import { SubmitButton } from "@/components/ui/submit-button";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/lib/home";

// Create SUBSCRIPTION_PLANS using stripePriceId from siteConfig
export const SUBSCRIPTION_PLANS = {
  FREE: siteConfig.cloudPricingItems.find(item => item.name === 'Free')?.stripePriceId || '',
  PRO: siteConfig.cloudPricingItems.find(item => item.name === 'Pro')?.stripePriceId || '',
  ENTERPRISE: siteConfig.cloudPricingItems.find(item => item.name === 'Enterprise')?.stripePriceId || '',
};

interface PlanComparisonProps {
  accountId?: string | null;
  returnUrl?: string;
  isManaged?: boolean;
  onPlanSelect?: (planId: string) => void;
  className?: string;
}

// Price display animation component
const PriceDisplay = ({ tier }: { tier: typeof siteConfig.cloudPricingItems[number] }) => {
  return (
    <motion.span
      key={tier.price}
      className="text-4xl font-semibold"
      initial={{
        opacity: 0,
        x: 10,
        filter: "blur(5px)",
      }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
    >
      {tier.price}
    </motion.span>
  );
};

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
        
        setCurrentPlanId(data?.price_id || SUBSCRIPTION_PLANS.FREE);
      } else {
        setCurrentPlanId(SUBSCRIPTION_PLANS.FREE);
      }
    }
    
    fetchCurrentPlan();
  }, [accountId]);

  return (
    <div className={cn("grid min-[650px]:grid-cols-2 min-[900px]:grid-cols-3 gap-4 w-full max-w-6xl mx-auto", className)}>
      {siteConfig.cloudPricingItems.map((tier) => {
        const isCurrentPlan = currentPlanId === SUBSCRIPTION_PLANS[tier.name.toUpperCase() as keyof typeof SUBSCRIPTION_PLANS];
        
        return (
          <div
            key={tier.name}
            className={cn(
              "rounded-xl bg-background border border-border p-6 flex flex-col gap-6",
              isCurrentPlan && "ring-2 ring-primary"
            )}
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-medium">{tier.name}</h3>
                {tier.isPopular && (
                  <span className="bg-primary text-primary-foreground text-xs font-medium px-2 py-0.5 rounded-full">
                    Popular
                  </span>
                )}
                {isCurrentPlan && (
                  <span className="bg-secondary text-secondary-foreground text-xs font-medium px-2 py-0.5 rounded-full">
                    Current Plan
                  </span>
                )}
              </div>
              <div className="flex items-baseline">
                <PriceDisplay tier={tier} />
                <span className="text-muted-foreground ml-2">
                  {tier.price !== "$0" ? "/month" : ""}
                </span>
              </div>
              <p className="text-muted-foreground">{tier.description}</p>
              <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium bg-secondary/10 text-secondary">
                {tier.hours}/month
              </div>
            </div>

            {!isCurrentPlan && accountId && (
              <form className="mt-2">
                <input type="hidden" name="accountId" value={accountId} />
                <input type="hidden" name="returnUrl" value={returnUrl} />
                <input type="hidden" name="planId" value={SUBSCRIPTION_PLANS[tier.name.toUpperCase() as keyof typeof SUBSCRIPTION_PLANS]} />
                {isManaged ? (
                  <SubmitButton
                    pendingText="Loading..."
                    formAction={setupNewSubscription}
                    className={cn(
                      "w-full h-10 rounded-full font-medium transition-colors",
                      tier.buttonColor
                    )}
                  >
                    {tier.buttonText}
                  </SubmitButton>
                ) : (
                  <Button
                    className={cn(
                      "w-full h-10 rounded-full font-medium transition-colors",
                      tier.buttonColor
                    )}
                    onClick={() => onPlanSelect?.(SUBSCRIPTION_PLANS[tier.name.toUpperCase() as keyof typeof SUBSCRIPTION_PLANS])}
                  >
                    {tier.buttonText}
                  </Button>
                )}
              </form>
            )}

            <div className="space-y-4">
              {tier.name !== "Free" && (
                <p className="text-sm text-muted-foreground">
                  Everything in {tier.name === "Basic" ? "Free" : "Basic"} +
                </p>
              )}
              <ul className="space-y-3">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-muted-foreground">
                    <div className="size-5 rounded-full bg-primary/10 flex items-center justify-center">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        className="text-primary"
                      >
                        <path
                          d="M2.5 6L5 8.5L9.5 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <span className="text-sm">{feature}</span>
                  </li>
                ))}
              </ul>
              
              {(tier as any).showContactSales && (
                <Button
                  variant="outline"
                  className="w-full h-10 rounded-full font-medium transition-colors mt-4"
                  onClick={() => window.open('mailto:support@kortix.ai?subject=Enterprise Plan Inquiry', '_blank')}
                >
                  Need more? Contact Sales
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
} 