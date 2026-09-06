import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';
import { notFound } from 'next/navigation';
import { DECKS, findDeck, localizedDecks } from '../registry';
import { DeckClient } from './deck-client';

export function generateStaticParams() {
  return DECKS.map((d) => ({ deck: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ deck: string }>;
}): Promise<Metadata> {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const { deck: slug } = await params;
  const deck = localizedDecks(tI18nComplete).find((candidate) => candidate.slug === slug);
  if (!deck)
    return {
      title: tI18nComplete.raw('textd84b8be91e7b'),
      robots: { index: false, follow: false },
    };
  return {
    title: tI18nComplete('text538b07594b07', { value0: deck.title }),
    description: deck.description,
    // Internal decks. They are shared by link, never indexed.
    robots: { index: false, follow: false },
  };
}

export default async function DeckPage({ params }: { params: Promise<{ deck: string }> }) {
  const { deck: slug } = await params;
  if (!findDeck(slug)) notFound();
  return <DeckClient slug={slug} />;
}
