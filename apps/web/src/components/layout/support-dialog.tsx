'use client';

/**
 * SupportDialog — the one "how do I get help?" surface.
 *
 * Two sections:
 *   1. Personal help from Marko (founder) — book a call / WhatsApp / email.
 *      Cloud-only; gated by SHOW_PERSONAL_CONTACT so self-hosters don't see
 *      the maintainer's face by default.
 *   2. Direct support — support@kortix.ai (copy-to-clipboard) + a link to
 *      the docs. Always visible.
 *
 * Triggered from the user menu's "Support" row.
 */

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  CalendarDays,
  Copy,
  Mail,
  MessageCircle,
} from 'lucide-react';
import Cal, { getCalApi } from '@calcom/embed-react';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { SHOW_PERSONAL_CONTACT } from '@/lib/kortix-flags';
import { cn } from '@/lib/utils';

const CAL_LINK = 'marko-kraemer/kortix-onboarding';
const CAL_NAMESPACE = 'kortix-support';
const MARKO_EMAIL = 'marko@kortix.ai';
const MARKO_WHATSAPP = '17372940835';
const SUPPORT_EMAIL = 'support@kortix.ai';

export function SupportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [calOpen, setCalOpen] = useState(false);

  useEffect(() => {
    if (!SHOW_PERSONAL_CONTACT) return;
    (async function () {
      const cal = await getCalApi({ namespace: CAL_NAMESPACE });
      cal('ui', { hideEventTypeDetails: true, layout: 'month_view' });
      cal('on', {
        action: 'bookingSuccessful',
        callback: () => {
          window.setTimeout(() => setCalOpen(false), 1500);
        },
      });
    })();
  }, []);

  const copyEmail = useCallback(async (email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      toast.success(`${email} copied`);
    } catch {
      window.location.href = `mailto:${email}`;
    }
  }, []);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg gap-0 overflow-hidden rounded-3xl p-0">
          <div className="px-7 pt-7 pb-5">
            <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
              Get help
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              We&rsquo;re here when you need us.
            </DialogDescription>
          </div>

          {SHOW_PERSONAL_CONTACT && (
            <>
              <div className="border-t border-border/60 px-7 py-6">
                <SectionLabel>Personal help from the founder</SectionLabel>
                <div className="mt-3 flex items-start gap-4">
                  <div className="relative size-14 shrink-0 overflow-hidden rounded-2xl border border-border/60 bg-muted">
                    <Image
                      src="/marko.png"
                      alt="Marko Kraemer"
                      width={112}
                      height={112}
                      className="size-full object-cover"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium tracking-tight text-foreground">
                      Marko Kraemer
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Founder &amp; CEO, Kortix
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-foreground/85">
                      Want a hand setting up your company&rsquo;s AI command
                      center? Book a call or message me on WhatsApp.
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => setCalOpen(true)}
                    className="gap-1.5"
                  >
                    <CalendarDays />
                    Book a call
                  </Button>
                  <Button asChild size="sm" variant="outline" className="gap-1.5">
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
                    size="sm"
                    variant="outline"
                    onClick={() => copyEmail(MARKO_EMAIL)}
                    className="gap-1.5"
                  >
                    <Mail />
                    {MARKO_EMAIL}
                  </Button>
                </div>
              </div>
            </>
          )}

          <div className="border-t border-border/60 px-7 py-6">
            <SectionLabel>Direct support</SectionLabel>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              For bug reports, account issues, and general questions, email
              the team. We reply within one business day.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyEmail(SUPPORT_EMAIL)}
                className="gap-1.5"
              >
                <Copy />
                {SUPPORT_EMAIL}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                  router.push('/docs');
                }}
                className="gap-1.5"
              >
                <BookOpen />
                Read the docs
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {SHOW_PERSONAL_CONTACT && (
        <Dialog open={calOpen} onOpenChange={setCalOpen}>
          <DialogContent
            hideCloseButton
            className={cn(
              'max-w-[min(900px,95vw)] gap-0 overflow-hidden rounded-2xl',
              'border-none bg-transparent p-0 shadow-none',
            )}
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
      )}
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
      {children}
    </div>
  );
}
