import { Effect } from 'effect';
import type { Context, Next } from 'hono';
import { runHttpEffect } from './http';

const promiseToEffect = <A>(operation: () => Promise<A> | A) =>
  Effect.tryPromise({
    try: async () => operation(),
    catch: (cause) => cause,
  });

export const effectMiddleware = (_c: Context, next: Next) =>
  runHttpEffect(promiseToEffect(next));

export const effectHandler =
  <C extends Context, A>(handler: (c: C) => Promise<A> | A) =>
  (c: C) =>
    runHttpEffect(promiseToEffect(() => handler(c)));
