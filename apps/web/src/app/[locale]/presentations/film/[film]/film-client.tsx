'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { FilmPlayer, FilmRender, FilmStill } from '../engine/film';
import { findFilm } from '../registry';

/**
 * `?render=1` hands the stage to `scripts/film/render.ts`; `?frame=N` shows one
 * frame; otherwise the film plays.
 */
function Mount({ slug }: { slug: string }) {
  const film = findFilm(slug);
  const params = useSearchParams();
  if (!film) notFound();
  if (params.get('render')) return <FilmRender film={film} />;
  const still = params.get('frame');
  return (
    <div className="dark bg-background fixed inset-0">
      {still ? <FilmStill film={film} frame={Number(still)} /> : <FilmPlayer film={film} />}
    </div>
  );
}

export function FilmClient({ slug }: { slug: string }) {
  return (
    <Suspense>
      <Mount slug={slug} />
    </Suspense>
  );
}
