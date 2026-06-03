'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { CalendarDays, Mail, MessageCircle, X } from 'lucide-react';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/components/AuthProvider';
import { useProjectOnboarding } from '@/hooks/projects/use-project-onboarding';
import { usePersonalContactTier } from '@/hooks/use-show-personal-contact';
import { DemoQualifierDialog } from '@/components/contact/demo-qualifier-dialog';
import { cn } from '@/lib/utils';

const MARKO_CAL_LINK = 'marko-kraemer/kortix-onboarding';
const MARKO_CAL_NAMESPACE = 'kortix-onboarding';
const MARKO_EMAIL = 'marko@kortix.ai';
const MARKO_WHATSAPP = '17372940835';
const STORAGE_KEY = 'kortix:marko-welcome-dismissed';

function useDismissed(): [boolean, () => void, boolean] {
  const [dismissed, setDismissed] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      setDismissed(false);
    }
    setHydrated(true);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
  }, []);

  return [dismissed, dismiss, hydrated];
}

export function PersonalOnboardingWelcome({
  projectId,
}: {
  /** When provided, the widget hides while that project's onboarding
   *  wizard is still pending — so the user only sees one CTA at a time. */
  projectId?: string;
} = {}) {
  const { user } = useAuth();
  const tier = usePersonalContactTier();
  const isPaid = tier === 'personal';
  const [dismissed, dismiss, hydrated] = useDismissed();
  const [qualifierOpen, setQualifierOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const onboarding = useProjectOnboarding(projectId ?? '');
  const wizardPending =
    !!projectId && onboarding.hydrated && onboarding.status === 'pending';

  // Slide-in once dismissed-state has hydrated and we know we should render.
  useEffect(() => {
    if (!hydrated || dismissed) {
      setVisible(false);
      return;
    }
    const t = window.setTimeout(() => setVisible(true), 60);
    return () => window.clearTimeout(t);
  }, [hydrated, dismissed]);

  // Cloud-only (self-hosters never see the founder). The card itself shows for
  // everyone on cloud — Marko is the default; the BOOKING is screened via the
  // qualifier below. Subscription only gates the personal WhatsApp line.
  if (tier === 'none') return null;
  if (!hydrated || dismissed) return null;
  if (wizardPending) return null;

  const defaultName =
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name as string | undefined) ||
    '';
  const defaultEmail = user?.email ?? '';

  return (
    <>
      <div
        className={cn(
          'fixed z-40 transition-all duration-300 ease-out',
          'bottom-4 right-4 sm:bottom-6 sm:right-6',
          'w-[min(480px,calc(100vw-2rem))]',
          visible ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0',
        )}
        role="complementary"
        aria-label="Welcome from Marko"
      >
        <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card shadow-lg">
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className={cn(
              'absolute right-4 top-4 z-10 grid size-8 place-items-center rounded-full',
              'text-muted-foreground/70 hover:bg-muted hover:text-foreground',
              'transition-colors',
            )}
          >
            <X className="size-4" />
          </button>

          <div className="relative flex flex-col gap-5 p-6 sm:p-7">
            <div className="flex items-start gap-4">
              <div className="relative size-12 shrink-0 overflow-hidden rounded-2xl border border-border/60 bg-muted">
                <Image
                  src="/marko.png"
                  alt="Marko Kraemer"
                  width={96}
                  height={96}
                  priority
                  className="size-full object-cover"
                />
              </div>

              <div className="min-w-0 flex-1 pr-8">
                <h2 className="text-base font-semibold tracking-tight text-foreground">
                  Hey, I&rsquo;m Marko
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Founder &amp; CEO, Kortix
                </p>
              </div>
            </div>

            <p className="text-sm leading-relaxed text-foreground/90">
              Want a hand setting up your company&rsquo;s AI command center?
              {isPaid
                ? ' Book a call or send me a WhatsApp message whenever you need help.'
                : ' Book a call whenever you need help.'}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setQualifierOpen(true)}>
                <CalendarDays />
                Book a call
              </Button>
              {isPaid && (
                <Button asChild variant="outline">
                  <a
                    href={`https://wa.me/${MARKO_WHATSAPP}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MessageCircle />
                    WhatsApp
                  </a>
                </Button>
              )}
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(MARKO_EMAIL);
                    toast.success('Email copied');
                  } catch {
                    window.location.href = `mailto:${MARKO_EMAIL}`;
                  }
                }}
              >
                <Mail />
                {MARKO_EMAIL}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Same screening gate as the public demo: small teams get routed to
          self-serve instead of onto Marko's calendar. */}
      <DemoQualifierDialog
        open={qualifierOpen}
        onOpenChange={setQualifierOpen}
        calLink={MARKO_CAL_LINK}
        calNamespace={MARKO_CAL_NAMESPACE}
        source="marko-widget"
        title="Book a call with Marko"
        description="A couple of quick details so Marko can tailor the call — or point you to self-serve if that's faster."
        defaultName={defaultName}
        defaultEmail={defaultEmail}
        selfServeHref="/projects"
      />
    </>
  );
}
