'use client';

/**
 * The browser half of `queue-migration.ts`: real `localStorage`, one pass at a
 * time, and no throw that can reach a React effect.
 *
 * Kept apart from the migration itself so that module stays pure and fully
 * asserted — every rule about ordering, retries, and what is kept is tested
 * against injected storage rather than against a DOM.
 *
 * ONE PASS AT A TIME, per tab. `SessionTabsContainer` pre-mounts every open
 * session simultaneously, so without the chain below N mounted sessions would
 * read the same blob, each POST its own rows, and each write back what it
 * thought was left — a lost update that resurrects rows another pass had just
 * migrated. Serializing costs nothing (a pass with no blob returns before any
 * I/O) and makes the read-modify-write atomic within the tab.
 *
 * TWO SESSION IDS, AND THEY ARE NOT INTERCHANGEABLE. `sessionId` is the Kortix
 * id, the only one `POST .../prompts` takes. `wireSessionId` is the OpenCode
 * chat id, the only one the transcript — and therefore
 * `mintSessionWireMessageId` — is keyed by. They are named apart, and passed
 * apart, because minting under the wrong one returns a silently backdated id
 * (see `MigrateTarget`).
 */

import type { CreateSessionPromptInput, CreateSessionPromptResult } from '@kortix/sdk';
import { mintSessionWireMessageId } from '@kortix/sdk/react';

import { migrateLegacyQueueToInbox } from './queue-migration';

/** The tail of the migration chain for this document. */
let pass: Promise<unknown> = Promise.resolve();

/** The three `localStorage` calls this module makes. */
export interface MigrationStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** `localStorage` throws in private mode and is absent on the server. */
function browserStorage(): MigrationStorage | null {
  try {
    return (globalThis as { localStorage?: MigrationStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function runLegacyQueueMigration(args: {
  /** Every id this session's rows could be filed under: the OpenCode chat id
   *  the old store keyed by, and the Kortix session id the route uses. */
  legacyIds: string[];
  projectId: string;
  /** The KORTIX session id — what `POST .../prompts` is addressed to. */
  sessionId: string;
  /** The OPENCODE chat id — what the wire message id is minted against. */
  wireSessionId: string;
  enqueue: (input: CreateSessionPromptInput) => Promise<CreateSessionPromptResult>;
  /** Test seam only. The browser supplies neither: there is no `localStorage`
   *  and no transcript store in a unit test, and the wiring these two carry is
   *  precisely what has to be asserted. */
  adapters?: {
    storage?: MigrationStorage | null;
    mint?: (openCodeSessionId: string) => string;
  };
}): Promise<void> {
  const store = args.adapters?.storage ?? browserStorage();
  if (!store) return Promise.resolve();
  const mint = args.adapters?.mint ?? mintSessionWireMessageId;

  const next = pass.then(async () => {
    try {
      const result = await migrateLegacyQueueToInbox({
        read: (key) => store.getItem(key),
        write: (key, value) => store.setItem(key, value),
        remove: (key) => store.removeItem(key),
        resolve: (legacySessionId) =>
          args.legacyIds.includes(legacySessionId)
            ? {
                projectId: args.projectId,
                sessionId: args.sessionId,
                wireSessionId: args.wireSessionId,
              }
            : null,
        // No `clientMessageId` argument: these rows are being placed for the
        // first time, and the id has to sort after everything already in the
        // transcript rather than reproduce a submission this tab made.
        //
        // `target.wireSessionId`, never `target.sessionId`: the minter reads
        // the transcript out of the sync store, which is keyed by the OpenCode
        // chat id. Handed the Kortix id it finds nothing, never lifts its
        // 2-minute clock backdate, and returns an id that can sort BELOW the
        // transcript — which OpenCode reads as already answered.
        mintMessageId: (target) => mint(target.wireSessionId),
        enqueue: (_projectId, _sessionId, input) => args.enqueue(input),
        onError: (message, cause) => console.warn(message, cause),
      });
      if (result.migrated > 0) {
        console.info(
          `[queue-migration] moved ${result.migrated} queued message(s) into the server inbox`,
        );
      }
    } catch (cause) {
      // A migration must never take a session down with it. The blob and its
      // attempt counter are untouched by a throw here, so the next load retries.
      console.warn('[queue-migration] pass failed', cause);
    }
  });
  pass = next;
  return next;
}
