'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { CalendarDays, Mail, MessageCircle, X } from 'lucide-react';
import Cal, { getCalApi } from '@calcom/embed-react';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useProjectOnboarding } from '@/hooks/projects/use-project-onboarding';
import { SHOW_PERSONAL_CONTACT } from '@/lib/kortix-flags';
import { cn } from '@/lib/utils';

const CAL_LINK = 'marko-kraemer/kortix-onboarding';
const CAL_NAMESPACE = 'kortix-onboarding';
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
  const [dismissed, dismiss, hydrated] = useDismissed();
  const [calOpen, setCalOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const onboarding = useProjectOnboarding(projectId ?? '');
  const wizardPending =
    !!projectId && onboarding.hydrated && onboarding.status === 'pending';

  useEffect(() => {
    (async function () {
      const cal = await getCalApi({ namespace: CAL_NAMESPACE });
      cal('ui', { hideEventTypeDetails: true, layout: 'month_view' });
      // Auto-close the cal modal after the booking is confirmed —
      // otherwise the user is stranded on cal's "scheduled" screen.
      cal('on', {
        action: 'bookingSuccessful',
        callback: () => {
          window.setTimeout(() => setCalOpen(false), 1500);
        },
      });
    })();
  }, []);

  // Slide-in once dismissed-state has hydrated and we know we should render.
  useEffect(() => {
    if (!hydrated || dismissed) {
      setVisible(false);
      return;
    }
    const t = window.setTimeout(() => setVisible(true), 60);
    return () => window.clearTimeout(t);
  }, [hydrated, dismissed]);

  const openCal = useCallback(() => setCalOpen(true), []);

  if (!SHOW_PERSONAL_CONTACT) return null;
  if (!hydrated || dismissed) return null;
  if (wizardPending) return null;

  return (
    <>
      <div
        className={cn(
          'fixed z-40 transition-all duration-300 ease-out',
          'bottom-4 right-4 sm:bottom-6 sm:right-6',
          'w-[min(560px,calc(100vw-2rem))]',
          visible ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0',
        )}
        role="complementary"
        aria-label="Welcome from Marko"
      >
        <div className="relative overflow-hidden rounded-3xl border border-border/60 bg-card">
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

          <div className="relative flex flex-col gap-6 p-8">
            <div className="flex items-start gap-5">
              <div className="relative size-14 shrink-0 overflow-hidden rounded-2xl border border-border/60 bg-muted">
                <Image
                  src="/marko.png"
                  alt="Marko Kraemer"
                  width={112}
                  height={112}
                  priority
                  className="size-full object-cover"
                />
              </div>

              <div className="min-w-0 flex-1 pr-8">
                <h2 className="text-lg font-semibold tracking-tight text-foreground">
                  Hey, I&rsquo;m Marko
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Founder &amp; CEO, Kortix
                </p>
              </div>
            </div>

            <p className="text-[15px] leading-relaxed text-foreground/90">
              Want a hand setting up your company&rsquo;s AI command center?
              Book a call or send me a WhatsApp message whenever you need help.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={openCal} className="gap-1.5">
                <CalendarDays />
                Book a call
              </Button>
              <Button asChild variant="outline" className="gap-1.5">
                <a
                  href={`https://wa.me/${MARKO_WHATSAPP}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <MessageCircle />
                  WhatsApp
                </a>
              </Button>
              <Button
                variant="outline"
                className="gap-1.5"
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

      <Dialog open={calOpen} onOpenChange={setCalOpen}>
        <DialogContent
          hideCloseButton
          className="max-w-[min(900px,95vw)] gap-0 overflow-hidden rounded-2xl border-none bg-transparent p-0 shadow-none"
        >
          <DialogTitle className="sr-only">Book a call with Marko</DialogTitle>
          <div className="h-[80vh] max-h-[760px] overflow-hidden rounded-2xl">
            <Cal
              namespace={CAL_NAMESPACE}
              calLink={CAL_LINK}
              style={{ width: '100%', height: '100%' }}
              config={{
                layout: 'month_view',
                hideEventTypeDetails: 'false',
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
