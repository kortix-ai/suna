import { Data, Effect, Either } from 'effect';

export type ProjectRouteResponse<A = unknown> = {
  readonly body: A;
  readonly status?: number;
};

export class ProjectRouteJsonError extends Data.TaggedError('ProjectRouteJsonError')<{
  readonly body: unknown;
  readonly status: number;
}> {}

export const routeJson = <A>(body: A, status?: number): ProjectRouteResponse<A> => ({ body, status });

export const failJson = (body: unknown, status: number): Effect.Effect<never, ProjectRouteJsonError> =>
  Effect.fail(new ProjectRouteJsonError({ body, status }));

export const failNotFound = (): Effect.Effect<never, ProjectRouteJsonError> =>
  failJson({ error: 'Not found' }, 404);

export const attemptRoute = <A>(operation: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => cause,
  });

export const attemptRouteSync = <A>(operation: () => A): Effect.Effect<A, unknown> =>
  Effect.try({
    try: operation,
    catch: (cause) => cause,
  });

export async function runProjectRouteEffect<A>(
  c: any,
  effect: Effect.Effect<ProjectRouteResponse<A>, unknown>,
) {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isRight(result)) {
    const response = result.right;
    if (response.status === undefined) return c.json(response.body);
    return c.json(response.body, response.status as any);
  }

  const error = result.left;
  if (error instanceof ProjectRouteJsonError) {
    return c.json(error.body, error.status as any);
  }
  throw error;
}
