'use client';

import { useTranslations } from '../../i18n';
import { useUiViewer } from '../../providers/ui-provider';
import { viewerFirstName } from './space-identity';

/** The personal space's name: "Ada's space", or "Your space" when the profile has no name. */
export function usePersonalSpaceName(): string {
  const t = useTranslations('sidebar.spaces');
  const first = viewerFirstName(useUiViewer()?.metadata);
  return first ? t('personalNamed', { name: first }) : t('personal');
}
