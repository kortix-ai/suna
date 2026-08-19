import { AppleMark, LinuxMark, PlayStoreMark, WindowsMark } from '@/components/brand/brand-logos';
import { ConsentGate } from '@/components/consent-gate';
import { DesktopCardImage, MobileCardImage } from '@/features/marketing/download/card-images';
import { DownloadCloseButton } from '@/features/marketing/download/close-button';
import {
  DESKTOP_CARD,
  DESKTOP_ROWS,
  MOBILE_CARD,
  MOBILE_ROWS,
  MOBILE_STATUS,
  hero,
} from '@/features/marketing/download/content';
import type { DesktopOs, MobileOs, Platform } from '@/features/marketing/download/detect-os';
import {
  detectPlatform,
  isMobilePlatform,
  normalizePlatform,
  orderedDesktop,
  orderedMobile,
} from '@/features/marketing/download/detect-os';
import type { CardRow } from '@/features/marketing/download/platform-card';
import { PlatformCard } from '@/features/marketing/download/platform-card';
import {
  formatSize,
  getLatestRelease,
  pickDesktopAsset,
} from '@/features/marketing/download/releases';
import { TerminalBlock } from '@/features/marketing/download/terminal-block';
import type { Metadata } from 'next';
import { marketingMetadata } from '@/lib/seo/metadata';
import { headers } from 'next/headers';

export const metadata: Metadata = marketingMetadata('/download');

const DESKTOP_MARKS: Record<DesktopOs, CardRow['Mark']> = {
  macos: AppleMark,
  windows: WindowsMark,
  linux: LinuxMark,
};

const MOBILE_MARKS: Record<MobileOs, CardRow['Mark']> = {
  ios: AppleMark,
  android: PlayStoreMark,
};
export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const [headerList, params, release] = await Promise.all([
    headers(),
    searchParams,
    getLatestRelease(),
  ]);

  const detected: Platform =
    normalizePlatform(params.platform) ?? detectPlatform(headerList.get('user-agent'));

  const desktopRows: CardRow[] = orderedDesktop(detected).map((os) => {
    const size = release ? formatSize(pickDesktopAsset(release.assets, os)?.size ?? 0) : '';
    return {
      id: os,
      label: DESKTOP_ROWS[os].label,
      // The size drops out of the join when GitHub is unreachable, leaving just
      // the copy. Never a placeholder, never a stale number.
      meta: [DESKTOP_ROWS[os].hint, size].filter(Boolean).join(' · '),
      href: DESKTOP_ROWS[os].href,
      Mark: DESKTOP_MARKS[os],
    };
  });

  const mobileRows: CardRow[] = orderedMobile(detected).map((os) => ({
    id: os,
    label: MOBILE_ROWS[os].label,
    meta: MOBILE_ROWS[os].hint,
    status: MOBILE_STATUS,
    Mark: MOBILE_MARKS[os],
  }));

  const onPhone = isMobilePlatform(detected);

  const desktopCard = (
    <PlatformCard
      key="desktop"
      image={<DesktopCardImage />}
      title={DESKTOP_CARD.title}
      description={DESKTOP_CARD.description}
      rows={desktopRows}
      filled={onPhone ? null : detected}
    />
  );

  const mobileCard = (
    <PlatformCard
      key="mobile"
      image={<MobileCardImage />}
      title={MOBILE_CARD.title}
      description={MOBILE_CARD.description}
      rows={mobileRows}
      // Nothing to fill: neither row has a button while both apps are unreleased.
      // A phone visitor therefore sees no solid button anywhere on the page,
      // which is accurate — there is nothing here they can install today.
      filled={null}
    />
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col justify-center px-6 py-16 md:py-0">
      <ConsentGate />

      {/* This route renders no nav and no footer, so it is the only way out. */}
      <DownloadCloseButton />

      <header className="mb-10 text-center">
        <h1 className="text-foreground text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {hero.title}
        </h1>
        <p className="text-muted-foreground mx-auto mt-3 max-w-md text-balance">{hero.sub}</p>
      </header>

      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {onPhone ? [mobileCard, desktopCard] : [desktopCard, mobileCard]}
        </div>
        <TerminalBlock />
      </div>
    </main>
  );
}
