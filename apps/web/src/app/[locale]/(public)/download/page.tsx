import { ConsentGate } from '@/components/consent-gate';
import { DownloadCloseButton } from '@/features/marketing/download/close-button';
import { localizedDownloadContent } from '@/features/marketing/download/content';
import type { DesktopOs } from '@/features/marketing/download/detect-os';
import {
  DESKTOP_ORDER,
  detectPlatform,
  normalizePlatform,
} from '@/features/marketing/download/detect-os';
import { DownloadOptions } from '@/features/marketing/download/download-options';
import {
  formatSize,
  getDesktopRelease,
  pickDesktopAsset,
} from '@/features/marketing/download/releases';
import { getTranslations } from '@/i18n/get-translations';
import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { Metadata } from 'next';
import { headers } from 'next/headers';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/download');
}

export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const [headerList, params, release, tI18nComplete] = await Promise.all([
    headers(),
    searchParams,
    getDesktopRelease(),
    getTranslations('hardcodedUi.i18nComplete'),
  ]);
  const { hero } = localizedDownloadContent(tI18nComplete);

  // The size drops out of the meta line when GitHub is unreachable. Never a
  // placeholder, never a stale number.
  const sizes: Partial<Record<DesktopOs, string>> = {};
  if (release) {
    for (const os of DESKTOP_ORDER) {
      sizes[os] = formatSize(pickDesktopAsset(release.assets, os)?.size ?? 0);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col justify-center px-6 py-16">
      <ConsentGate />

      {/* This route renders no nav and no footer, so the X is the way out. */}
      <DownloadCloseButton />

      <header className="mb-10 text-center">
        <h1 className="text-foreground text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {hero.title}
        </h1>
        <p className="text-muted-foreground mx-auto mt-3 max-w-md text-balance">{hero.sub}</p>
      </header>

      <DownloadOptions
        detected={
          normalizePlatform(params.platform) ?? detectPlatform(headerList.get('user-agent'))
        }
        sizes={sizes}
      />
    </main>
  );
}
