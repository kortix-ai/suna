'use client';

import { useMemo } from 'react';

import { selectSessionHarness, type RuntimeV2 } from '@kortix/shared/session-harness';
import { useProjectConfig } from '@kortix/sdk/react';

import { useProjectFeatureFlags } from './use-project-feature-flags';

/**
 * The harness a NEW session of this project boots — the SAME `selectSessionHarness`
 * the api's provisioning rides, fed from the same three inputs the web already
 * holds: the project's `pi_harness` and `llm_gateway` flags (both fail closed to
 * `false`) and the config scan's `runtime` mirror (absent on pre-KRTX-2543
 * servers ⇒ `null`, the flags-only read). The web's draft pick spells a picked
 * skill with it (`composer-logic` `draftCommandText`): `/skill:<name>` only on
 * pi — OpenCode ran a skill as a plain `/name` (KRTX-2543).
 */
export function useSessionHarness(projectId: string | null | undefined): 'opencode' | 'pi' {
  const { flags } = useProjectFeatureFlags(projectId);
  const projectConfig = useProjectConfig(projectId ?? null);
  return useMemo(
    () =>
      selectSessionHarness({
        piHarnessFlag: flags.pi_harness === true,
        runtime: (projectConfig?.runtime ?? null) as RuntimeV2 | null,
        llmGateway: flags.llm_gateway === true,
      }),
    [flags.pi_harness, flags.llm_gateway, projectConfig?.runtime],
  );
}
