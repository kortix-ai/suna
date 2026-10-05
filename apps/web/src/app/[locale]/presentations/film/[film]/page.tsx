import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FILMS, findFilm } from '../registry';
import { FilmClient } from './film-client';

export function generateStaticParams() {
  return FILMS.map((f) => ({ film: f.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ film: string }>;
}): Promise<Metadata> {
  const film = findFilm((await params).film);
  return {
    title: film ? `${film.title} · Kortix` : 'Kortix',
    description: film?.description,
    // Shared by link, never indexed — same rule as the decks.
    robots: { index: false, follow: false },
  };
}

export default async function FilmPage({ params }: { params: Promise<{ film: string }> }) {
  if (!findFilm((await params).film)) notFound();
  return <FilmClient slug={(await params).film} />;
}
