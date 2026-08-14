'use client';

import { EnvelopeIcon, PhoneIcon, XIcon } from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';
import Link from 'next/link';
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
import Hint from '@/components/ui/hint';
import { successToast } from '@/components/ui/toast';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { WhatsApp } from '@/features/icon/icons/whats-app';
import { useAuth } from '@/features/providers/auth-provider';
import { useProjectOnboarding } from '@/hooks/projects/use-project-onboarding';
import { usePersonalContactTier } from '@/hooks/use-show-personal-contact';
import { cn } from '@/lib/utils';

const MARKO_CAL_LINK = 'team/kortix/demo';
const MARKO_CAL_NAMESPACE = 'kortix-onboarding';
const MARKO_EMAIL = 'marko@kortix.ai';
const MARKO_WHATSAPP = '17372940835';
const STORAGE_KEY = 'kortix:marko-welcome-dismissed';

const enterTransition = { type: 'spring' as const, duration: 0.3, bounce: 0 };

export function PersonalOnboardingWelcome({ projectId }: { projectId?: string } = {}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { user } = useAuth();
  const tier = usePersonalContactTier();
  const reduceMotion = useReducedMotion();
  const [dismissed, setDismissed] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [qualifierOpen, setQualifierOpen] = useState(false);
  const onboarding = useProjectOnboarding(projectId ?? '');
  const wizardPending = !!projectId && onboarding.hydrated && onboarding.status === 'pending';

  useEffect(() => {
    setDismissed(localStorage.getItem(STORAGE_KEY) === '1');
    setHydrated(true);
  }, []);

  if (tier !== 'personal') return null;
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

  const motionOff = !!reduceMotion;

  return (
    <>
      <m.aside
        role="complementary"
        aria-label={tI18nHardcoded.raw(
          'autoComponentsProjectsPersonalOnboardingWelcomeJsxAttrAriaLabelWelcome436613af',
        )}
        initial={motionOff ? false : { opacity: 0, transform: 'translateY(8px)' }}
        animate={{ opacity: 1, transform: 'translateY(0px)' }}
        transition={enterTransition}
        className={cn(
          'fixed z-40',
          'inset-e-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))]',
          'w-[min(22.5rem,calc(100vw-2rem))]',
        )}
      >
        <Card className="bg-popover border-border/60 border shadow-lg">
          <CardHeader>
            <m.div
              initial={motionOff ? false : { opacity: 0, transform: 'translateY(6px)' }}
              animate={{ opacity: 1, transform: 'translateY(0px)' }}
              transition={{ ...enterTransition, delay: motionOff ? 0 : 0.04 }}
              className="flex items-center gap-3 pe-8"
            >
              <div className="bg-muted size-10 shrink-0 overflow-hidden rounded-md">
                <Image
                  src="/marko.png"
                  alt="Marko Kraemer"
                  width={80}
                  height={80}
                  className="size-full object-cover outline-1 outline-black/10 dark:outline-white/10"
                />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-base text-balance">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsPersonalOnboardingWelcomeJsxTextHeyIMe9d73cdb',
                  )}
                </CardTitle>
                <CardDescription className="truncate">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsPersonalOnboardingWelcomeJsxTextFounderCEOKortix4be58c34',
                  )}
                </CardDescription>
              </div>
            </m.div>
            <CardAction>
              <Hint label="Dismiss" side="top" align="end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={dismiss}
                  aria-label="Dismiss"
                  className="text-muted-foreground hover:text-foreground hit-area-1 active:scale-[0.96]"
                >
                  <XIcon className="size-4" />
                </Button>
              </Hint>
            </CardAction>
          </CardHeader>

          <CardContent className="pt-2">
            <m.p
              initial={motionOff ? false : { opacity: 0, transform: 'translateY(6px)' }}
              animate={{ opacity: 1, transform: 'translateY(0px)' }}
              transition={{ ...enterTransition, delay: motionOff ? 0 : 0.1 }}
              className="text-muted-foreground text-sm text-pretty"
            >
              {tI18nHardcoded.raw(
                'autoComponentsProjectsPersonalOnboardingWelcomeJsxTextWantAHandf0a0c56c',
              )}
            </m.p>
          </CardContent>

          <CardFooter className="w-full flex-col items-stretch gap-3">
            <m.div
              initial={motionOff ? false : { opacity: 0, transform: 'translateY(6px)' }}
              animate={{ opacity: 1, transform: 'translateY(0px)' }}
              transition={{ ...enterTransition, delay: motionOff ? 0 : 0.16 }}
              className="flex w-full flex-col gap-2"
            >
              <Button
                size="sm"
                className="w-full active:scale-[0.96]"
                onClick={() => setQualifierOpen(true)}
              >
                <PhoneIcon weight="fill" className="size-3.5 shrink-0" />
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsPersonalOnboardingWelcomeJsxTextBookADemo7f3fc2d5',
                )}
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button asChild size="sm" variant="outline" className="w-full active:scale-[0.96]">
                  <Link href={`https://wa.me/${MARKO_WHATSAPP}`} target="_blank" rel="noreferrer">
                    <WhatsApp className="size-3.5" />
                    WhatsApp
                  </Link>
                </Button>
                <div className="min-w-0">
                  <Hint label={MARKO_EMAIL} side="top">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={copyEmail}
                      className="w-full active:scale-[0.96]"
                    >
                      <EnvelopeIcon className="size-3.5 shrink-0" />
                      Email
                    </Button>
                  </Hint>
                </div>
              </div>
            </m.div>
          </CardFooter>
        </Card>
      </m.aside>

      <DemoQualifierModal
        open={qualifierOpen}
        onOpenChange={setQualifierOpen}
        calLink={MARKO_CAL_LINK}
        calNamespace={MARKO_CAL_NAMESPACE}
        source="marko-widget"
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsPersonalOnboardingWelcomeJsxAttrTitleBookA33a960c8',
        )}
        description={tI18nHardcoded.raw(
          'autoComponentsProjectsPersonalOnboardingWelcomeJsxAttrDescriptionACouple5d67eddc',
        )}
        defaultName={defaultName}
        defaultEmail={defaultEmail}
      />
    </>
  );
}
