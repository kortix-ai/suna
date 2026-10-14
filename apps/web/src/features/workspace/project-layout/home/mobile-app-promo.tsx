'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@/components/ui/modal';
import { Apple } from '@/features/icon/icons/apple';
import { PlayStore } from '@/features/icon/icons/playstore';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@/features/marketing/download/mobile-store-urls';
import { useTranslations } from '@/i18n/use-translations';
import { useMobileAppPromoStore } from '@/stores/mobile-app-promo-store';
import { BellIcon, ChatCircleIcon, MicrophoneIcon, type Icon } from '@phosphor-icons/react';
import Image from 'next/image';
import Link from 'next/link';
import { useSyncExternalStore } from 'react';

const FEATURES: readonly { key: 'sessions' | 'notifications' | 'dictation'; icon: Icon }[] = [
  { key: 'sessions', icon: ChatCircleIcon },
  { key: 'notifications', icon: BellIcon },
  { key: 'dictation', icon: MicrophoneIcon },
];

/**
 * The panel's art, sampled from the eclipse orb it is modelled on: bone at the
 * top, a red horizon, navy, then black. One art value, so its raw colours live
 * in this one constant. `in oklab` keeps the brightness even through the band.
 */
/**
 * The card's shadow: the smooth stack from shadow.floriankiem.com
 * (`smooth-shadow-lg`, shadow-plugin, MIT), copied as its five black layers,
 * each twice as far and as soft as the last, so the edge fades instead of
 * ending. No border ring layer: the card draws its own border.
 */
// prettier-ignore
const SMOOTH_SHADOW_LG = '0 25px 50px 0 rgba(0, 0, 0, 0.05), 0 12px 24px 0 rgba(0, 0, 0, 0.04), 0 6px 12px 0 rgba(0, 0, 0, 0.03), 0 3px 6px 0 rgba(0, 0, 0, 0.02), 0 1.5px 3px 0 rgba(0, 0, 0, 0.02)';

// prettier-ignore
const MOBILE_PROMO_GRADIENT = 'linear-gradient(170deg in oklab, #DAD9D5 0%, #DAD9D5 34%, #943637 50%, #1D1F2C 60%, #000 82%)';

const STORES = [
  { key: 'appStore', icon: Apple, href: APP_STORE_URL },
  { key: 'googlePlay', icon: PlayStore, href: GOOGLE_PLAY_URL },
] as const;

/** Nothing to subscribe to: false on the server, true once mounted. */
const subscribeToNothing = () => () => {};

/**
 * Introduces the Kortix mobile app on the project page, once per browser.
 * Same frame as "Connect your computer" (`features/tunnel/computer-connect.tsx`),
 * mirrored: the copy and the two store buttons first, the app shot beside
 * them. Every way out closes it for good (`mobile-app-promo-store.ts`).
 */
export function MobileAppPromo() {
  const t = useTranslations('mobileAppPromo');
  const closed = useMobileAppPromoStore((state) => state.closed);
  const close = useMobileAppPromoStore((state) => state.close);
  // The closed flag lives in localStorage, which the server cannot read: open
  // only after hydration, so a browser that closed it never sees it flash.
  const mounted = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

  return (
    <Modal
      open={mounted && !closed}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {/* No entrance animation: it opens on its own when the project page
          loads, so it appears at once. Closing still fades (Radix exit). */}
      <ModalContent
        animation="none"
        overlayClassName="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-(--duration-moderate)"
        className="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 space-y-0 duration-(--duration-moderate) lg:max-w-3xl"
      >
        {/* 55 / 45: copy first, the art on the trailing side. From `sm` up
            only: on a phone the copy and the store buttons stand alone. The
            art is the download page's mobile poster
            (`marketing/download/card-images.tsx`) on the orb gradient. It
            rounds its own outer corners: the modal is a scroll container and
            its clip does not reach it. */}
        <div className="grid sm:grid-cols-[11fr_9fr] lg:min-h-128">
          <div
            style={{ backgroundImage: MOBILE_PROMO_GRADIENT }}
            className="relative hidden overflow-hidden rounded-tr-xl border-l sm:order-last sm:block lg:rounded-br-xl"
          >
            {/* The download page's mobile poster as a card: centered, its top
                corners rounded, its bottom edge flush with the panel's, so it
                reads as rising out of the panel. Anchored to the top, so the
                headline always shows whole. */}
            {/* Border and shadow live on the card, not the image: the card's
                `overflow-hidden` would clip a shadow drawn by its child, while
                its own shadow paints outside it. */}
            <div
              style={{ boxShadow: SMOOTH_SHADOW_LG }}
              className="border-border absolute inset-x-0 top-16 bottom-0 mx-auto w-[68%] overflow-hidden rounded-t-xl border-x-[3px] border-t-[3px]"
            >
              <Image
                src="/images/mobile-app/app-1.png"
                alt={t('pill')}
                fill
                sizes="(min-width: 640px) 250px, 68vw"
                className="object-cover object-top"
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-4 p-5 sm:gap-5 lg:p-8">
            <header className="space-y-1.5 pr-10 sm:pr-0">
              <Badge variant="info" size="xs" className="text-kortix-blue mb-2 ring-0">
                {t('badge')}
              </Badge>
              <ModalTitle className="text-lg font-medium text-balance">{t('title')}</ModalTitle>
              <ModalDescription className="text-pretty">{t('description')}</ModalDescription>
            </header>

            <ul className="divide-border divide-y">
              {FEATURES.map(({ key, icon: FeatureIcon }) => (
                <li key={key} className="flex items-center gap-3 py-2.5 sm:py-3">
                  <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-sm sm:size-10">
                    <FeatureIcon className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-sm font-medium">{t(`feature.${key}`)}</p>
                    <p className="text-muted-foreground text-xs text-pretty">
                      {t(`feature.${key}Description`)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>

            {/* Actions sit on the bottom edge, level with the foot of the art.
                Two equal choices, so one weight for both. */}
            <div className="mt-auto grid grid-cols-2 gap-2">
              {STORES.map(({ key, icon: StoreIcon, href }) => (
                <Button key={key} size="lg" className="w-full text-sm" asChild>
                  <Link href={href} target="_blank" rel="noopener noreferrer" onClick={close}>
                    <StoreIcon />
                    {t(key)}
                  </Link>
                </Button>
              ))}
            </div>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}
