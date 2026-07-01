import { Context, Effect, Layer } from 'effect';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@kortix/db';
import { config, SANDBOX_VERSION } from '../config';
import { db, hasDatabase } from '../shared/db';
import { getSupabase } from '../shared/supabase';

export type AppConfigValue = typeof config & {
  readonly SANDBOX_VERSION: string;
};

export class AppConfig extends Context.Tag('AppConfig')<
  AppConfig,
  AppConfigValue
>() {}

export class DatabaseService extends Context.Tag('DatabaseService')<
  DatabaseService,
  {
    readonly database: Database;
    readonly hasDatabase: boolean;
  }
>() {}

export class SupabaseService extends Context.Tag('SupabaseService')<
  SupabaseService,
  {
    readonly client: Effect.Effect<SupabaseClient, Error>;
  }
>() {}

export class HttpClient extends Context.Tag('HttpClient')<
  HttpClient,
  {
    readonly fetch: typeof fetch;
  }
>() {}

export type ApiServiceContext =
  | AppConfig
  | DatabaseService
  | SupabaseService
  | HttpClient;

export const AppConfigLive = Layer.succeed(AppConfig, {
  ...config,
  SANDBOX_VERSION,
});

export const DatabaseLive = Layer.succeed(DatabaseService, {
  database: db,
  hasDatabase,
});

export const SupabaseLive = Layer.succeed(SupabaseService, {
  client: Effect.try({
    try: () => getSupabase(),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Supabase client initialization failed: ${String(cause)}`),
  }),
});

export const HttpClientLive = Layer.succeed(HttpClient, {
  fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
});

export const ApiLiveLayer = Layer.mergeAll(
  AppConfigLive,
  DatabaseLive,
  SupabaseLive,
  HttpClientLive,
);

export const provideApiServices = <A, E>(
  effect: Effect.Effect<A, E, ApiServiceContext>,
): Effect.Effect<A, E> => Effect.provide(effect, ApiLiveLayer);
