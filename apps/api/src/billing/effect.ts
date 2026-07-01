import { Effect } from 'effect';
import type { Database } from '@kortix/db';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppConfig, DatabaseService, SupabaseService } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

export const billingConfig = await runEffectOrThrow(Effect.gen(function* () {
  return yield* AppConfig;
}));

export const billingDb: Database = await runEffectOrThrow(Effect.gen(function* () {
  const { database } = yield* DatabaseService;
  return database;
}));

export const billingHasDatabase = await runEffectOrThrow(Effect.gen(function* () {
  const { hasDatabase } = yield* DatabaseService;
  return hasDatabase;
}));

export const billingSupabase: SupabaseClient = await runEffectOrThrow(Effect.gen(function* () {
  const service = yield* SupabaseService;
  return yield* service.client;
}));

export const billingSleep = (ms: number): Promise<void> =>
  runEffectOrThrow(Effect.sleep(`${ms} millis`));

export const runBillingInterval = (
  operation: () => Promise<void> | void,
  ms: number,
): void => {
  Effect.runFork(
    Effect.forever(
      Effect.zipRight(
        Effect.tryPromise(async () => operation()).pipe(
          Effect.catchAll((cause) => Effect.sync(() => {
            console.error('[billing] scheduled task failed:', cause);
          })),
        ),
        Effect.sleep(`${ms} millis`),
      ),
    ),
  );
};
