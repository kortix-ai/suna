import { Effect } from 'effect';
import type { Database } from '@kortix/db';
import { DatabaseService } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

export const runIamDatabase = <A>(
  operation: (database: Database) => Promise<A> | A,
): Promise<A> =>
  runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    return yield* Effect.tryPromise(async () => operation(database));
  }));

export const sleepIam = (ms: number): Promise<void> =>
  runEffectOrThrow(Effect.sleep(`${ms} millis`));
