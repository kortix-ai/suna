import { Effect } from 'effect';
import type { Database } from '@kortix/db';
import { AppConfig, DatabaseService, HttpClient } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

export const platformConfig = await runEffectOrThrow(Effect.gen(function* () {
  return yield* AppConfig;
}));

export const platformSandboxVersion = platformConfig.SANDBOX_VERSION;

export type SandboxProviderName = (typeof platformConfig.ALLOWED_SANDBOX_PROVIDERS)[number];

export const platformDb: Database = await runEffectOrThrow(Effect.gen(function* () {
  const { database } = yield* DatabaseService;
  return database;
}));

export const platformHasDatabase = await runEffectOrThrow(Effect.gen(function* () {
  const { hasDatabase } = yield* DatabaseService;
  return hasDatabase;
}));

export const platformFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> =>
  runEffectOrThrow(Effect.gen(function* () {
    const client = yield* HttpClient;
    return yield* Effect.tryPromise(() => client.fetch(input, init));
  }));

export const platformSleep = (ms: number): Promise<void> =>
  runEffectOrThrow(Effect.sleep(`${ms} millis`));
