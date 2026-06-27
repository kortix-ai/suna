'use client';

/**
 * One-time hydration of the user's model-picker preferences from the server.
 *
 * On app mount, if localStorage has no globalDefault / visibility pins but the
 * server has them (persisted per auth user via /v1/me/model-preferences), we
 * seed localStorage so the resolution chain in use-opencode-local.ts and the
 * picker's visibility logic pick them up.
 *
 * This runs once per page load — the module-level guard prevents repeated
 * fetches. The seed functions never overwrite existing local state, so a user's
 * in-session changes (the optimistic cache) always win over a slower server read.
 */

import { useEffect, useRef } from 'react';
import { getModelPreferences } from '@/lib/projects-client';
import {
  hydrateGlobalDefaultFromServer,
  hydrateVisibilityFromServer,
} from './use-model-store';

let hydrated = false;

export function useModelHydration(enabled = true) {
  const didRun = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (didRun.current || hydrated) return;
    didRun.current = true;
    hydrated = true;

    getModelPreferences()
      .then((data) => {
        if (!data) return;

        // Default model — stored as "providerID/modelID".
        if (typeof data.default === 'string' && data.default) {
          const model = data.default;
          const idx = model.indexOf('/');
          if (idx > 0 && idx < model.length - 1) {
            hydrateGlobalDefaultFromServer({
              providerID: model.slice(0, idx),
              modelID: model.slice(idx + 1),
            });
          }
        }

        // Per-model visibility pins.
        if (Array.isArray(data.hidden)) {
          hydrateVisibilityFromServer(data.hidden);
        }
      })
      .catch(() => {
        // Non-fatal — app works fine without server-side preferences.
      });
  }, [enabled]);
}
