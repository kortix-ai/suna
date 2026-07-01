import { Effect } from 'effect';
import type { Database } from '@kortix/db';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppConfig, DatabaseService, HttpClient, SupabaseService } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

export const sandboxProxyConfig = await runEffectOrThrow(Effect.gen(function* () {
  return yield* AppConfig;
}));

export type SandboxProviderName = (typeof sandboxProxyConfig.ALLOWED_SANDBOX_PROVIDERS)[number];

export const sandboxProxyDb: Database = await runEffectOrThrow(Effect.gen(function* () {
  const { database } = yield* DatabaseService;
  return database;
}));

export const sandboxProxySupabase: SupabaseClient = await runEffectOrThrow(Effect.gen(function* () {
  const service = yield* SupabaseService;
  return yield* service.client;
}));

export const sandboxProxyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> =>
  runEffectOrThrow(Effect.gen(function* () {
    const client = yield* HttpClient;
    return yield* Effect.tryPromise(() => client.fetch(input, init));
  }));

export const sandboxProxySleep = (ms: number): Promise<void> =>
  runEffectOrThrow(Effect.sleep(`${ms} millis`));

export const runSandboxProxyInterval = (
  operation: () => void | Promise<void>,
  ms: number,
): void => {
  Effect.runFork(
    Effect.forever(
      Effect.zipRight(
        Effect.tryPromise(async () => operation()).pipe(Effect.catchAll(() => Effect.void)),
        Effect.sleep(`${ms} millis`),
      ),
    ),
  );
};
