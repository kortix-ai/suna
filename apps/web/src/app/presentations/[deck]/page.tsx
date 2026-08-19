import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DECKS, findDeck } from '../registry';
import { DeckClient } from './deck-client';

export function generateStaticParams() {
  return DECKS.map((d) => ({ deck: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ deck: string }>;
}): Promise<Metadata> {
  const { deck: slug } = await params;
  const deck = findDeck(slug);
  if (!deck) return { title: 'Kortix — Presentations', robots: { index: false, follow: false } };
  return {
    title: `Kortix — ${deck.title}`,
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
