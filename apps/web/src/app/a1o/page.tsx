import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';
import { DiceStage } from './dice-stage';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi.i18nComplete');
  return {
    title: { absolute: t.raw('text16b9d8d63ecb') },
    description: t.raw('textf48bdbd4d197'),
    alternates: { canonical: 'https://kortix.com/a1o' },
  };
}

export default function A1oPage() {
  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-black">
      <DiceStage />
    </main>
  );
}
