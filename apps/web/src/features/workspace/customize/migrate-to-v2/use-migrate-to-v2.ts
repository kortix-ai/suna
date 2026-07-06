'use client';

/**
 * useMigrateToV2 — start an agent-led "migrate this project's manifest to v2"
 * session from anywhere in Customize.
 *
 * Same shape as `useConfigureThread` (the sibling "Create new agent/skill/
 * command" flow): the only way config changes land is through a session that
 * edits the repo on a branch and opens a change request, so this mints a
 * fresh session, stashes the migration prompt as its first message, closes
 * the Customize overlay, and drops the user into the thread — the instant
 * shell auto-sends the stashed prompt once the runtime is ready.
 *
 * Deliberately does NOT pass `agent_name` — the session boots the project's
 * default agent (the one with git/CR powers), matching how the migration
 * prompt expects to be run.
 */

import { useCallback } from 'react';

import type { StartStash } from '@kortix/sdk/react';

import { MIGRATE_TO_V2_PROMPT } from './migration-prompt';
import { buildUpgradeStash, useRunUpgrade } from './use-run-upgrade';

/** Pure — the exact stash payload the migration session is seeded with.
 *  Split out from the hook so it's unit-testable without React. */
export function buildMigrateToV2Stash(): StartStash {
  return buildUpgradeStash(MIGRATE_TO_V2_PROMPT);
}

export interface MigrateToV2 {
  /** Mint + navigate to the migration session. Safe to call repeatedly —
   *  ignored while a session is already being created. */
  start: () => void;
  /** True while a session is being created — callers should disable their
   *  trigger and/or show a spinner. */
  pending: boolean;
}

export function useMigrateToV2(projectId: string): MigrateToV2 {
  const run = useRunUpgrade(projectId);
  const start = useCallback(() => run.start(MIGRATE_TO_V2_PROMPT), [run]);
  return { start, pending: run.pending };
}
