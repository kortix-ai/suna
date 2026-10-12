/** One page of the managed catalogue, as `listConnectCatalogPage` returns it. */
type ListApps<A> = (input: {
  projectId: string;
  provider: 'composio' | 'pipedream';
  q: string;
  limit: number;
}) => Promise<{ apps: A[] }>;

/**
 * Resolve one managed (Composio or Pipedream) app from its slug.
 *
 * The catalogue has no by-slug route, so this searches and keeps the exact
 * slug match. The second query spells the slug as words, for a catalogue whose
 * search matches names and not slugs (`google_sheets` → "google sheets").
 *
 * `list` is passed in so this module stays free of the catalogue hook's
 * imports and can be tested with a fake.
 */
export async function findEasyConnectApp<A extends { slug: string }>(
  list: ListApps<A>,
  input: { projectId: string; provider: 'composio' | 'pipedream'; slug: string },
): Promise<(A & { provider: 'composio' | 'pipedream' }) | null> {
  const words = input.slug.replace(/[_-]+/g, ' ');
  for (const q of words === input.slug ? [input.slug] : [input.slug, words]) {
    // ponytail: one page of 48 per query; an exact slug ranked below 48 results
    // reads as not found. Add a by-slug API route if that happens.
    const page = await list({ projectId: input.projectId, provider: input.provider, q, limit: 48 });
    const app = page.apps.find((candidate) => candidate.slug === input.slug);
    if (app) return { ...app, provider: input.provider };
  }
  return null;
}
