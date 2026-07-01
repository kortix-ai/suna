import { Effect, Fiber } from 'effect';
import type { Database } from '@kortix/db';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppConfig, DatabaseService, HttpClient, SupabaseService } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

export const sharedConfig = await runEffectOrThrow(Effect.gen(function* () {
  return yield* AppConfig;
}));

export const sharedDb: Database = await runEffectOrThrow(Effect.gen(function* () {
  const { database } = yield* DatabaseService;
  return database;
}));

export const sharedSupabase: SupabaseClient = await runEffectOrThrow(Effect.gen(function* () {
  const service = yield* SupabaseService;
  return yield* service.client;
}));

export const sharedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> =>
  runEffectOrThrow(Effect.gen(function* () {
    const client = yield* HttpClient;
    return yield* Effect.tryPromise(() => client.fetch(input, init));
  }));

export const sharedSleep = (ms: number): Promise<void> =>
  runEffectOrThrow(Effect.sleep(`${ms} millis`));

export type SharedTimer = Fiber.RuntimeFiber<unknown, unknown>;

export const runSharedTimeout = (
  operation: () => void | Promise<void>,
  ms: number,
): SharedTimer =>
  Effect.runFork(
    Effect.zipRight(
      Effect.sleep(`${ms} millis`),
      Effect.tryPromise(async () => operation()).pipe(Effect.catchAll(() => Effect.void)),
    ),
  );

export const runSharedInterval = (
  operation: () => void | Promise<void>,
  ms: number,
): SharedTimer =>
  Effect.runFork(
    Effect.forever(
      Effect.zipRight(
        Effect.tryPromise(async () => operation()).pipe(Effect.catchAll(() => Effect.void)),
        Effect.sleep(`${ms} millis`),
      ),
    ),
  );

export const stopSharedTimer = (timer: SharedTimer | null | undefined): void => {
  if (timer) Effect.runFork(Fiber.interrupt(timer));
};
