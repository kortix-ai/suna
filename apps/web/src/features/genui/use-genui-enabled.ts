import { createContext, useContext } from 'react';

import { useUserPreferencesStore } from '@/stores/user-preferences-store';

/** true renders blocks as UI whatever the preference says. Only the /debug/genui page provides it. */
export const GenuiForceEnabledContext = createContext(false);

/** The viewer's generative UI preference. Default on. */
export function useGenuiEnabled(): boolean {
  const forced = useContext(GenuiForceEnabledContext);
  const preferred = useUserPreferencesStore((s) => s.preferences.genuiEnabled ?? true);
  return forced || preferred;
}
