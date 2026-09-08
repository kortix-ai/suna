import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';
import { KortixParticleMark } from './kortix-particle-mark';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi.i18nComplete');
  return {
    title: t.raw('text6397aa583ce4'),
    description: t.raw('text20432b11333f'),
    robots: { index: false, follow: false },
  };
}

export default function RauchPage() {
  return (
    <main className="bg-background fixed inset-0 overflow-hidden">
      <KortixParticleMark />
    </main>
  );
}
