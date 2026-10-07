import { RepoTreeRows } from '../repo-tree-rows';
import { useTranslations } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { getLocalizedAgentsAndSkillsContent } from './content';

/**
 * Where an agent and a skill actually live, drawn as a directory listing. The
 * section's claim is that a workforce is text on disk, so the visual has to be
 * something you could have produced with `tree`.
 */
export function RepoTree(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { repo } = getLocalizedAgentsAndSkillsContent(tI18nComplete);
  return (
    <div className="border-border bg-card overflow-x-auto rounded-sm border p-5 sm:p-7">
      <RepoTreeRows entries={repo.tree} />
    </div>
  );
}
