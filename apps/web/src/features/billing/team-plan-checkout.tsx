'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import Loading from '@/components/ui/loading';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@/components/ui/modal';
import { useCreatePerSeatCheckout } from '@/hooks/billing';
import type { AccountState } from '@/lib/api/billing';
import { cn } from '@/lib/utils';
import { Heatmap } from '@paper-design/shaders-react';
import { ArrowRight, UserPlus } from 'lucide-react';

const TEAM_PLAN_HEATMAP = {
  speed: 1,
  contour: 0.5,
  angle: 0,
  noise: 0,
  innerGlow: 0.5,
  outerGlow: 0.05,
  scale: 0.3,
  image:
    'https://app.paper.design/file-assets/01KSZX87JES96T455ZX3RRGMPP/01KT47X1FY5YNJN6EPP8TW6ZB1.svg',
  frame: 407072.499999992,
  colors: ['var(--kortix-orange)', '#fafafa', '#242424'],
  colorBack: '#ffffff00',
};

export interface TeamPlanCheckoutProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
}

export function TeamPlanCheckout({ open, onOpenChange, accountState }: TeamPlanCheckoutProps) {
  const createPerSeat = useCreatePerSeatCheckout();

  const pricePerSeat = accountState?.seats?.price_per_seat_usd ?? 40;
  const seatCount = Math.max(1, accountState?.member_count ?? accountState?.seats?.count ?? 1);
  const monthlyTotal = pricePerSeat * seatCount;
  const hasSeatMath = seatCount > 1;

  const canManageBilling = accountState?.can_manage_billing !== false;

  const handleSubscribe = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    createPerSeat.mutate({
      success_url: `${origin}/projects?team_signup=success`,
      cancel_url: typeof window !== 'undefined' ? window.location.href : `${origin}/`,
    });
  };

  const included = [
    `$${pricePerSeat} of usage credit per teammate, every month`,
    'Every model — drawn from one shared team wallet',
    'AI Computers to run code, browsers, and terminals',
    'Spend on compute, LLM, or both — one wallet, auto top-up',
    'Auto-prorated as teammates join or leave',
  ];

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="gap-0 space-y-0 overflow-hidden p-0 lg:flex lg:h-[55dvh] lg:max-w-5xl lg:flex-col">
        <ModalTitle className="sr-only">Subscribe to Kortix Team</ModalTitle>
        <ModalDescription className="sr-only">
          ${pricePerSeat} per seat per month. LLM compute and AI Computers for every teammate.
        </ModalDescription>

        <div className="grid min-h-0 flex-1 lg:grid-cols-12">
          <div className={cn('relative min-h-[220px] overflow-hidden', 'lg:col-span-5 lg:min-h-0')}>
            <Heatmap
              {...TEAM_PLAN_HEATMAP}
              className="absolute inset-2 rounded-lg"
              style={{ backgroundColor: 'var(--border)' }}
            />
          </div>

          <div className="flex h-full min-h-0 flex-1 flex-col justify-between lg:col-span-7">
            <div className="flex flex-col items-start space-y-8 px-6 py-8 pt-2 lg:py-8">
              <div className="space-y-4">
                <Badge variant="kortix" className="rounded">
                  Kortix Team
                </Badge>
                <div className="space-y-1">
                  <p
                    className="text-5xl leading-none font-semibold tracking-tight tabular-nums"
                    style={{ fontKerning: 'none' }}
                  >
                    ${pricePerSeat}
                  </p>
                  <p className="text-muted-foreground text-sm leading-snug">
                    per seat
                    <span aria-hidden className="text-muted-foreground/35 mx-1.5">
                      ·
                    </span>
                    billed monthly
                  </p>
                </div>
                <p className="text-muted-foreground max-w-[300px] text-sm leading-relaxed">
                  LLM compute and AI Computers for every teammate. Add seats as your team grows.
                </p>
              </div>

              <ul className="w-full space-y-3">
                {included.map((item, index) => (
                  <li key={index} className="flex items-center gap-2">
                    <KortixAsterisk index={index} />
                    <span className="text-foreground text-sm leading-snug">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-auto space-y-3 p-6 pt-0 lg:pt-6">
              {hasSeatMath && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {seatCount} {seatCount === 1 ? 'seat' : 'seats'} × ${pricePerSeat}
                  </span>
                  <span className="font-medium tabular-nums">${monthlyTotal}/mo</span>
                </div>
              )}

              {canManageBilling ? (
                <>
                  <Button
                    onClick={handleSubscribe}
                    disabled={createPerSeat.isPending}
                    size="xl"
                    className="group w-full rounded-lg"
                  >
                    {createPerSeat.isPending ? (
                      <>
                        <Loading />
                        Starting checkout…
                      </>
                    ) : (
                      <>
                        {hasSeatMath
                          ? `Subscribe — $${monthlyTotal}/mo`
                          : `Subscribe — $${pricePerSeat}/seat`}
                        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                      </>
                    )}
                  </Button>
                  <p className="text-muted-foreground text-center text-xs">
                    Auto-prorated · cancel anytime · billed monthly
                  </p>
                </>
              ) : (
                <div className="border-border/60 bg-background flex items-start gap-3 rounded-2xl border px-4 py-3.5">
                  <Hint
                    label="Only account owners can subscribe. Your seat activates automatically once they do."
                    side="top"
                    className="max-w-xs text-xs"
                  >
                    <span className="bg-muted text-muted-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
                      <UserPlus className="size-4" />
                    </span>
                  </Hint>
                  <div className="space-y-0.5">
                    <p className="text-foreground text-sm font-medium">
                      Ask an account owner for a seat
                    </p>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      Only account owners can manage billing. Once an owner subscribes to Kortix
                      Team, your seat is activated automatically.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}
