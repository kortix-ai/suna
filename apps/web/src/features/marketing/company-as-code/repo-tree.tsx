import { RepoTreeRows } from '../repo-tree-rows';
import { useTranslations } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { getLocalizedCompanyAsCodeContent } from './content';

/**
 * The repo, drawn as the thing it is: a directory listing you could have
 * produced with `tree`. The section's claim is that none of this is hidden, so
 * the visual has to be the real paths from the shipped starter template.
 */
export function RepoTree(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { repo } = getLocalizedCompanyAsCodeContent(tI18nComplete);
  return (
    <div className="border-border bg-card h-full overflow-x-auto rounded-sm border p-5 sm:p-7">
      <RepoTreeRows entries={repo.tree} compact />
    </div>
  );
}
