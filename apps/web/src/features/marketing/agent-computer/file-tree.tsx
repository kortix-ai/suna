import { useTranslations } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { RepoTreeRows } from '../repo-tree-rows';
import { getLocalizedAgentComputerContent } from './content';

/**
 * The repo the machine clones, drawn as the thing it is: a directory listing.
 * The section's claim is that none of this is hidden state, so the visual has to
 * be something you could have produced with `tree`.
 */
export function FileTree(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { files } = getLocalizedAgentComputerContent(tI18nComplete);
  return (
    <div className="border-border bg-card h-full overflow-x-auto rounded-xl border p-5 sm:p-7">
      <RepoTreeRows entries={files.tree} />
    </div>
  );
}
