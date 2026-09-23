/**
 * connect-model — where "Connect provider" sends the user.
 *
 * Web opens its project provider modal. Mobile has no gateway model screen
 * (mobile ships core features only), so a gateway project opens web's routed
 * twin of that modal, `/projects/:id/customize/models`, in the browser.
 */
import { Linking } from 'react-native';

import { getFrontendUrl } from '@/api/config';

export function projectModelsWebUrl(frontendUrl: string, projectId: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/customize/models`;
}

export function openProjectModelsOnWeb(projectId: string): void {
  void Linking.openURL(projectModelsWebUrl(getFrontendUrl(), projectId)).catch(() => {});
}
