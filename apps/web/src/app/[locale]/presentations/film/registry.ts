/**
 * The film registry. A film is a slug, a frame count, a root component, and
 * its sound cues. Add a row to publish /presentations/film/<slug>.
 * The authoring guide: `.agents/skills/kortix-presentation/references/films.md`.
 */

import type { FilmDef } from './engine/film';
import { launchFilm } from './films/launch';
import { rentVsOwnFilm } from './films/rent-vs-own';

export const FILMS: readonly FilmDef[] = [launchFilm, rentVsOwnFilm];

export const findFilm = (slug: string) => FILMS.find((f) => f.slug === slug);
