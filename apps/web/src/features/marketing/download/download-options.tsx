import { AppleMark, LinuxMark, PlayStoreMark, WindowsMark } from '@/components/brand/brand-logos';
import { useTranslations } from '@/i18n/use-translations';
import Link from '@/components/site-link';

import { DesktopCardImage, MobileCardImage } from './card-images';
import { localizedDownloadContent } from './content';
import type { DesktopOs, MobileOs, Platform } from './detect-os';
import { DESKTOP_ORDER, MOBILE_ORDER, isMobilePlatform } from './detect-os';
import { MobileQrRow } from './mobile-qr-row';
import type { CardRow } from './platform-card';
import { PlatformCard } from './platform-card';
import { TerminalBlock } from './terminal-block';

const DESKTOP_MARKS: Record<DesktopOs, CardRow['Mark']> = {
  macos: AppleMark,
  windows: WindowsMark,
  linux: LinuxMark,
};

const MOBILE_MARKS: Record<MobileOs, CardRow['Mark']> = {
  ios: AppleMark,
  android: PlayStoreMark,
};

/**
 * The Desktop card, the Mobile card and the Terminal block. The /download page
 * and the in-app Download App modal both render THIS, so the two surfaces stay
 * one design.
 *
 * `sizes` is optional: the page resolves installer sizes from GitHub on the
 * server, the modal does not. A missing size drops out of the meta line.
 *
 * A desktop visitor gets the QR row in the Mobile card: they are not on the
 * phone the store link is for, so the code carries the link to it. A phone
 * visitor gets the store buttons only.
 */
export function DownloadOptions({
  detected,
  sizes,
}: {
  detected: Platform;
  sizes?: Partial<Record<DesktopOs, string>>;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tComputers = useTranslations('computers');
  const { desktopCard, mobileCard, desktopRows, mobileRows } =
    localizedDownloadContent(tI18nComplete);
  const onPhone = isMobilePlatform(detected);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <PlatformCard
          image={<DesktopCardImage />}
          title={desktopCard.title}
          description={
            <>
              {desktopCard.description}{' '}
              <Link
                href="/settings/computer"
                className="text-foreground underline underline-offset-4"
              >
                {tComputers('connectYourComputer')}
              </Link>
            </>
          }
          rows={DESKTOP_ORDER.map((os) => ({
            id: os,
            label: desktopRows[os].label,
            meta: [desktopRows[os].hint, sizes?.[os]].filter(Boolean).join(' · '),
            href: desktopRows[os].href,
            Mark: DESKTOP_MARKS[os],
          }))}
          filled={onPhone ? null : detected}
        />
        <PlatformCard
          // Desktop sits left and Mobile right at md+, always. On the stacked
          // phone layout a phone visitor sees the Mobile card first.
          className={onPhone ? 'order-first md:order-none' : undefined}
          image={<MobileCardImage />}
          title={mobileCard.title}
          description={mobileCard.description}
          aside={onPhone ? null : <MobileQrRow />}
          rows={MOBILE_ORDER.map((os) => ({
            id: os,
            label: mobileRows[os].label,
            meta: mobileRows[os].hint,
            href: mobileRows[os].href,
            external: true,
            Mark: MOBILE_MARKS[os],
          }))}
          // A phone visitor's own store gets the one solid button.
          filled={onPhone ? detected : null}
        />
      </div>
      <TerminalBlock />
    </div>
  );
}
