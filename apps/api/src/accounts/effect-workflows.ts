import { Data, Effect, Either } from 'effect';
import type { Context } from 'hono';

type JsonBody = Record<string, unknown>;
type JsonResponse = JsonBody | unknown[];
type HttpStatus = 200 | 201 | 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500 | number;

export interface AccountRouteResponse<A extends JsonResponse = JsonBody> {
  readonly body: A;
  readonly status: HttpStatus;
}

export class AccountRouteError extends Data.TaggedError('AccountRouteError')<{
  readonly body: JsonBody;
  readonly status: HttpStatus;
}> {}

export class AccountDependencyError extends Data.TaggedError('AccountDependencyError')<{
  readonly cause: unknown;
}> {}

export type AccountWorkflow<A extends JsonResponse = JsonBody> = Effect.Effect<
  AccountRouteResponse<A>,
  AccountRouteError | AccountDependencyError
>;

export const accountResponse = <A extends JsonResponse>(
  body: A,
  status: HttpStatus = 200,
): AccountRouteResponse<A> => ({ body, status });

export const accountFail = (body: JsonBody, status: HttpStatus) =>
  Effect.fail(new AccountRouteError({ body, status }));

export const accountTry = <A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new AccountDependencyError({ cause }),
  });

export const accountTrySync = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) => new AccountDependencyError({ cause }),
  });

export const readJsonRecord = (c: Context) =>
  Effect.tryPromise({
    try: async () => ((await c.req.json()) ?? {}) as Record<string, unknown>,
    catch: () => new AccountDependencyError({ cause: new Error('invalid_json') }),
  }).pipe(Effect.catchAll(() => Effect.succeed({} as Record<string, unknown>)));

export async function runAccountWorkflow(
  c: Context,
  workflow: Effect.Effect<any, AccountRouteError | AccountDependencyError>,
): Promise<any> {
  const result = await Effect.runPromise(Effect.either(workflow));
  if (Either.isRight(result)) {
    return c.json(result.right.body, result.right.status as never);
  }

  const error = result.left;
  if (error instanceof AccountRouteError) {
    return c.json(error.body, error.status as never);
  }
  if (error instanceof AccountDependencyError) {
    throw error.cause;
  }
  throw error;
}
