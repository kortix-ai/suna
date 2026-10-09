import { useUserPreferencesStore } from '@/stores/user-preferences-store';

/** The viewer's generative UI preference. Default on. */
export function useGenuiEnabled(): boolean {
  return useUserPreferencesStore((s) => s.preferences.genuiEnabled ?? true);
}
