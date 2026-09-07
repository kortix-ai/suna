import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';
import { GameOfLife } from './game-of-life';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi.i18nComplete');
  return {
    title: t.raw('textc94d0e1fcb3d'),
    description: t.raw('text6f3297022a6b'),
    robots: { index: false, follow: false },
  };
}

export default function GameOfLifePage() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-white">
      <GameOfLife />
    </main>
  );
}
