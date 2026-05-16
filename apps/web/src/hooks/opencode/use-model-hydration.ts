'use client';

/**
 * One-time hydration of the global default model from the server.
 *
 * On app mount, if localStorage has no globalDefault but the server has one
 * (persisted in opencode.jsonc via PUT /kortix/preferences/model), we seed
 * localStorage so the resolution chain in use-opencode-local.ts picks it up.
 *
 * This runs once per page load — the module-level guard prevents repeated fetches.
 */

import { useEffect, useRef } from 'react';
import { getActiveOpenCodeUrl } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';
import { hydrateGlobalDefaultFromServer } from './use-model-store';

let hydrated = false;

export function useModelHydration(enabled = true) {
  const didRun = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (didRun.current || hydrated) return;
    didRun.current = true;
    hydrated = true;

    const base = getActiveOpenCodeUrl();
    if (!base) return;

    authenticatedFetch(`${base}/kortix/preferences/model`)
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        if (!data?.model) return;

        // Parse "providerID/modelID" format
        const model = data.model as string;
        const idx = model.indexOf('/');
        if (idx <= 0 || idx >= model.length - 1) return;

        const providerID = model.slice(0, idx);
        const modelID = model.slice(idx + 1);

        // Uses the model store's internal setStore which notifies all subscribers
        hydrateGlobalDefaultFromServer({ providerID, modelID });
      })
      .catch(() => {
        // Non-fatal — app works fine without server-side default
      });
  }, [enabled]);
}
