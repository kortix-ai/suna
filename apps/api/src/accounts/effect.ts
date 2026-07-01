import { Effect } from 'effect';
import type { Database } from '@kortix/db';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppConfig, DatabaseService, HttpClient, SupabaseService } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

export const accountConfig = await runEffectOrThrow(Effect.gen(function* () {
  return yield* AppConfig;
}));

export const accountDb: Database = await runEffectOrThrow(Effect.gen(function* () {
  const { database } = yield* DatabaseService;
  return database;
}));

export const accountSupabase: SupabaseClient = await runEffectOrThrow(Effect.gen(function* () {
  const service = yield* SupabaseService;
  return yield* service.client;
}));

export const accountFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> =>
  runEffectOrThrow(Effect.gen(function* () {
    const client = yield* HttpClient;
    return yield* Effect.tryPromise(() => client.fetch(input, init));
  }));

export const accountSleep = (ms: number): Promise<void> =>
  runEffectOrThrow(Effect.sleep(`${ms} millis`));
