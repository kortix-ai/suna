import { Effect } from 'effect';
import type { Database } from '@kortix/db';
import { AppConfig, DatabaseService, HttpClient } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

export const llmGatewayConfig = await runEffectOrThrow(Effect.gen(function* () {
  return yield* AppConfig;
}));

export const runLlmGatewayDatabase = <A>(
  operation: (database: Database) => Promise<A> | A,
): Promise<A> =>
  runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    return yield* Effect.tryPromise(async () => operation(database));
  }));

export const runLlmGatewayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> =>
  runEffectOrThrow(Effect.gen(function* () {
    const client = yield* HttpClient;
    return yield* Effect.tryPromise(() => client.fetch(input, init));
  }));
