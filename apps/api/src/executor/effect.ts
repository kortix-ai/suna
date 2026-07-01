import { Effect } from 'effect';
import type { Database } from '@kortix/db';
import { AppConfig, DatabaseService, HttpClient } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

export const executorConfig = await runEffectOrThrow(Effect.gen(function* () {
  return yield* AppConfig;
}));

export const executorDb: Database = await runEffectOrThrow(Effect.gen(function* () {
  const { database } = yield* DatabaseService;
  return database;
}));

export const executorFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> =>
  runEffectOrThrow(Effect.gen(function* () {
    const client = yield* HttpClient;
    return yield* Effect.tryPromise(() => client.fetch(input, init));
  }));
