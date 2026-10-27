import { getAllUseCases } from '@/lib/use-cases';

import { TAG_TO_TEAM } from './use-case-teams';
import { UseCasesSection, type UseCaseItem } from './use-cases-section';

/**
 * Server half of the landing use-case ruler: reads the use-case library at
 * build time and hands the client section only what it renders — slug, url,
 * title and team — so the MDX never ships to the browser.
 */
export function UseCasesBand() {
  const items: UseCaseItem[] = [];
  for (const post of getAllUseCases()) {
    const team = TAG_TO_TEAM[post.data.tags[0] ?? ''];
    if (team) items.push({ slug: post.slug, url: post.url, title: post.data.title, team });
  }
  return (
    <UseCasesSection
      items={items}
      linkable={process.env.NEXT_PUBLIC_USE_CASES_ENABLED !== 'false'}
    />
  );
}
