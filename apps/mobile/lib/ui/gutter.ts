/**
 * A screen's side margin. `project` (16pt) is the default and what every
 * settings-style screen uses, so a settings page, an account page and the
 * project's own Account page share one edge (Jay, 2026-09-22 — the 20pt
 * `page` screens read as a different app beside it). `page` (20pt) is kept
 * for a surface that deliberately sits wider.
 */
export type Gutter = 'page' | 'project';
/** Side padding of a settings-style screen: `page` 20pt (`px-5`), `project` 16pt (`px-4`). */
export const GUTTER_CLASS: Record<Gutter, string> = {
  page: 'px-5',
  project: 'px-4',
};
