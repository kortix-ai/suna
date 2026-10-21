'use client';

import { Badge } from '../../primitives/badge';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '../../primitives/modal';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from '../../internal/lib/mobile-store-urls';
import { useTranslations } from '../../i18n';
import { useMobileAppPromoStore } from '../../internal/stores/mobile-app-promo-store';
import { MobileStoreQr } from '../../internal/components/mobile-store-qr';
import { PROMO_GRADIENT } from '../../internal/lib/promo-art';
import { BellIcon, ChatCircleIcon, MicrophoneIcon, type Icon } from '@phosphor-icons/react';
import { UiLink as Link, UiImage as Image } from '../../providers/ui-provider';
import { useSyncExternalStore } from 'react';
import { useIsMobile } from '../../hooks/use-mobile';

const FEATURES: readonly { key: 'sessions' | 'notifications' | 'dictation'; icon: Icon }[] = [
  { key: 'sessions', icon: ChatCircleIcon },
  { key: 'notifications', icon: BellIcon },
  { key: 'dictation', icon: MicrophoneIcon },
];

/**
 * The card's shadow: the smooth stack from shadow.floriankiem.com
 * (`smooth-shadow-lg`, shadow-plugin, MIT), copied as its five black layers,
 * each twice as far and as soft as the last, so the edge fades instead of
 * ending. No border ring layer: the card draws its own border.
 */
// prettier-ignore
const SMOOTH_SHADOW_LG = '0 25px 50px 0 rgba(0, 0, 0, 0.05), 0 12px 24px 0 rgba(0, 0, 0, 0.04), 0 6px 12px 0 rgba(0, 0, 0, 0.03), 0 3px 6px 0 rgba(0, 0, 0, 0.02), 0 1.5px 3px 0 rgba(0, 0, 0, 0.02)';


/** The official store badges, unmodified (Apple and Google forbid edits). Both are 3.375:1, so one height gives one width. */
/** Laid over the whole art panel: fades the card, border included, into the black floor. */
// prettier-ignore
const SCREEN_FADE = 'linear-gradient(to bottom in oklab, transparent 45%, #000 95%)';

const STORES = [
  { key: 'appStore', badge: '/images/store-badges/app-store.svg', href: APP_STORE_URL },
  { key: 'googlePlay', badge: '/images/store-badges/google-play.svg', href: GOOGLE_PLAY_URL },
] as const;

/** Nothing to subscribe to: false on the server, true once mounted. */
const subscribeToNothing = () => () => { };

/**
 * Introduces the Kortix mobile app on mobile project pages, once per browser.
 * Same frame as "Connect your computer" (`packages/ui/src/internal/tunnel/computer-connect.tsx`),
 * mirrored: the copy and the two store buttons first, the app shot beside
 * them. Every way out closes it for good (`mobile-app-promo-store.ts`).
 */
export function MobileAppPromo() {
  const t = useTranslations('mobileAppPromo');
  const isMobile = useIsMobile();
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
      open={mounted && isMobile && !closed}
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
            art is the first App Store screenshot on the orb gradient. It
            rounds its own outer corners: the modal is a scroll container and
            its clip does not reach it. */}
        <div className="grid sm:grid-cols-[11fr_9fr] lg:min-h-128">
          <div
            style={{ backgroundImage: PROMO_GRADIENT }}
            className="relative hidden overflow-hidden rounded-tr-xl border-l sm:order-last sm:block lg:rounded-br-xl"
          >
            {/* The App Store screenshot as a card: centered, its top
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
                src="/images/mobile-app/store-01.webp"
                alt={t('pill')}
                fill
                sizes="(min-width: 640px) 250px, 68vw"
                className="object-cover object-top"
              />
            </div>
            {/* Above the card, not inside it, so the fade covers the card's
                border too and the whole phone sinks into the black floor. */}
            <div aria-hidden style={{ backgroundImage: SCREEN_FADE }} className="pointer-events-none absolute inset-0" />
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
                On a computer the QR code comes first: the visitor is not on the
                phone the store buttons are for, so the camera is the shortest
                path. On a phone it is hidden and the two badges remain. Two
                equal choices, so one size for both badges. */}
            <div className="mt-auto space-y-4">
              <div className="hidden items-center gap-4 sm:flex">
                <MobileStoreQr />
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{t('scanTitle')}</p>
                  <p className="text-muted-foreground text-xs text-pretty">{t('scanDescription')}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {STORES.map(({ key, badge, href }) => (
                  <Link
                    key={key}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={close}
                    className="focus-visible:ring-ring rounded-md transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <Image src={badge} alt={t(key)} width={135} height={40} className="h-11 w-auto" />
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}
