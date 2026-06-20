'use client';

import { X } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { successToast } from '@/components/ui/toast';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { Icon } from '@/features/icon/icon';
import { useAuth } from '@/features/providers/auth-provider';
import { useProjectOnboarding } from '@/hooks/projects/use-project-onboarding';
import { usePersonalContactTier } from '@/hooks/use-show-personal-contact';
import { isWorkEmail } from '@/lib/personal-email';
import { cn } from '@/lib/utils';
import { TelephoneSolid } from '@mynaui/icons-react';
import Link from 'next/link';

const MARKO_CAL_LINK = 'team/kortix/demo';
const MARKO_CAL_NAMESPACE = 'kortix-onboarding';
const MARKO_EMAIL = 'marko@kortix.ai';
const MARKO_WHATSAPP = '17372940835';
const STORAGE_KEY = 'kortix:marko-welcome-dismissed';

export function PersonalOnboardingWelcome({ projectId }: { projectId?: string } = {}) {
  const { user } = useAuth();
  const tier = usePersonalContactTier();
  const isPaid = tier === 'personal';
  const [dismissed, setDismissed] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [qualifierOpen, setQualifierOpen] = useState(false);
  const onboarding = useProjectOnboarding(projectId ?? '');
  const wizardPending = !!projectId && onboarding.hydrated && onboarding.status === 'pending';

  useEffect(() => {
    setDismissed(localStorage.getItem(STORAGE_KEY) === '1');
    setHydrated(true);
  }, []);

  if (tier === 'none') return null;
  if (!isWorkEmail(user?.email)) return null;
  if (!hydrated || dismissed) return null;
  if (wizardPending) return null;

  const defaultName =
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name as string | undefined) ||
    '';
  const defaultEmail = user?.email ?? '';

  const dismiss = () => {
    setDismissed(true);
    localStorage.setItem(STORAGE_KEY, '1');
  };

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(MARKO_EMAIL);
      successToast('Email copied');
    } catch {
      window.location.href = `mailto:${MARKO_EMAIL}`;
    }
  };

  return (
    <>
      <Card
        className={cn(
          'bg-sidebar fixed z-40 gap-4 py-4 shadow-sm',
          'right-4 bottom-4 sm:right-6 sm:bottom-6',
          'w-[min(500px,calc(100vw-2rem))]',
        )}
        role="complementary"
        aria-label="Welcome from Marko"
      >
        <CardHeader className="px-4">
          <div className="flex items-center gap-3">
            <div className="bg-muted border-overlay size-10 shrink-0 overflow-hidden rounded-md">
              <Image
                src="/marko.png"
                alt="Marko Kraemer"
                width={80}
                height={80}
                className="img-outline size-full object-cover"
              />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-balance">Hey, I&rsquo;m Marko</CardTitle>
              <CardDescription>Founder &amp; CEO, Kortix</CardDescription>
            </div>
          </div>
          <CardAction>
            <Button variant="ghost" size="icon" onClick={dismiss} aria-label="Dismiss">
              <X />
            </Button>
          </CardAction>
        </CardHeader>

        <CardContent className="px-4">
          <p className="text-foreground/90 text-sm leading-relaxed text-pretty">
            Want a hand setting up your company&rsquo;s AI command center?
            {isPaid
              ? ' Book a call or send me a WhatsApp message whenever you need help.'
              : ' Book a demo and I’ll walk you through it.'}
          </p>
        </CardContent>

        <CardFooter className="flex-wrap gap-2 px-4">
          <Button size="sm" onClick={() => setQualifierOpen(true)}>
            <TelephoneSolid />
            Book a demo
          </Button>
          {isPaid && (
            <Button asChild size="sm" variant="outline">
              <Link href={`https://wa.me/${MARKO_WHATSAPP}`} target="_blank" rel="noreferrer">
                <Icon.WhatsApp />
                WhatsApp
              </Link>
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={copyEmail}>
            {MARKO_EMAIL}
          </Button>
        </CardFooter>
      </Card>

      <DemoQualifierModal
        open={qualifierOpen}
        onOpenChange={setQualifierOpen}
        calLink={MARKO_CAL_LINK}
        calNamespace={MARKO_CAL_NAMESPACE}
        source="marko-widget"
        title="Book a call with Marko"
        description="A couple of quick details so Marko can tailor the call."
        defaultName={defaultName}
        defaultEmail={defaultEmail}
      />
    </>
  );
}
