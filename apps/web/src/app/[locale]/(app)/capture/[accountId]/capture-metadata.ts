import type { Metadata } from 'next';

import { getTranslations } from '@/i18n/get-translations';

/** A page title inside the area's `%s · Kortix Capture` template. */
export async function captureMetadata(
  key: 'overview' | 'workflows' | 'devices' | 'timeline' | 'thisComputer' | 'settings',
): Promise<Metadata> {
  const t = await getTranslations('capture.area.nav');
  return { title: t(key) };
}
