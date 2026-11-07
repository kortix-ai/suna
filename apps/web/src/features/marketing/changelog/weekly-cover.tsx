'use client';

import { useTranslations } from '@/i18n/use-translations';
import Image from 'next/image';
import { useState } from 'react';
import type { WeeklyMedia } from './weekly-media';

/** A failed asset must not leave a broken image in an otherwise valid brief. */
export function WeeklyCover({ media }: { media: WeeklyMedia }) {
  const t = useTranslations('billing.access');
  const [failedUrl, setFailedUrl] = useState<string>();
  if (failedUrl === media.cover.url) return null;
  return (
    <figure className="mb-8">
      <Image
        src={media.cover.url}
        alt={media.cover.alt}
        width={media.cover.width}
        height={media.cover.height}
        sizes="(min-width: 1024px) 50vw, 100vw"
        className="h-auto w-full rounded-lg"
        onError={() => setFailedUrl(media.cover.url)}
      />
      {media.demoUrl && (
        <figcaption className="mt-3 text-sm">
          <a
            href={media.demoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-4"
          >
            {t('featuresDemoBadge')}
          </a>
        </figcaption>
      )}
    </figure>
  );
}
