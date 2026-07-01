import { Data, Effect, Either } from 'effect';
import type { Context } from 'hono';

type JsonBody = unknown;
type HttpStatus = 200 | 202 | 400 | 401 | 403 | 404 | 410 | 503 | number;

export type ChannelHttpResponse<A = JsonBody> =
  | { readonly kind: 'json'; readonly body: A; readonly status: HttpStatus }
  | { readonly kind: 'body'; readonly body: string; readonly status: HttpStatus };

export class ChannelHttpError extends Data.TaggedError('ChannelHttpError')<{
  readonly status: HttpStatus;
  readonly body: JsonBody;
}> {}

export class ChannelDependencyError extends Data.TaggedError('ChannelDependencyError')<{
  readonly cause: unknown;
}> {}

export const jsonResponse = <A>(body: A, status: HttpStatus = 200): ChannelHttpResponse<A> => ({
  kind: 'json',
  body,
  status,
});

export const emptyResponse = (status: HttpStatus = 200): ChannelHttpResponse<string> => ({
  kind: 'body',
  body: '',
  status,
});

export const failJson = (body: JsonBody, status: HttpStatus) =>
  Effect.fail(new ChannelHttpError({ body, status }));

export const dependency = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new ChannelDependencyError({ cause }),
  });

export const parseRawBody = (c: Context) => dependency(() => c.req.text() as Promise<string>);

export const parseJsonString = <A>(
  rawBody: string,
  invalidBody: JsonBody = { error: 'Invalid JSON' },
) =>
  Effect.try({
    try: () => JSON.parse(rawBody) as A,
    catch: () => new ChannelHttpError({ body: invalidBody, status: 400 }),
  });

export const parseOptionalJsonBody = <A>(c: Context, fallback: A) =>
  dependency(async () => {
    try {
      return (await c.req.json()) as A;
    } catch {
      return fallback;
    }
  });

export function fireAndLog<E>(label: string, effect: Effect.Effect<unknown, E>): void {
  void Effect.runPromise(
    effect.pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          const cause = error instanceof ChannelDependencyError ? error.cause : error;
          console.error(label, cause);
        }),
      ),
    ),
  );
}

export async function runChannelWorkflow<E>(
  c: Context,
  workflow: Effect.Effect<ChannelHttpResponse<unknown>, E>,
): Promise<never> {
  const result = await Effect.runPromise(Effect.either(workflow));
  if (Either.isRight(result)) {
    const response = result.right;
    if (response.kind === 'body') {
      return c.body(response.body, response.status as never) as never;
    }
    return c.json(response.body, response.status as never) as never;
  }

  const error = result.left;
  if (error instanceof ChannelHttpError) {
    return c.json(error.body, error.status as never) as never;
  }
  if (error instanceof ChannelDependencyError) {
    throw error.cause;
  }
  throw error;
}
