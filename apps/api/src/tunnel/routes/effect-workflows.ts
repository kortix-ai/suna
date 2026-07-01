import { Data, Effect, Either } from 'effect';
import { HTTPException } from 'hono/http-exception';

export type TunnelJsonResponse<T = unknown> = {
  readonly body: T;
  readonly status: number;
};

export class TunnelRouteError extends Data.TaggedError('TunnelRouteError')<{
  readonly status: number;
  readonly body: unknown;
}> {}

export const tunnelJson = <T>(body: T, status = 200): TunnelJsonResponse<T> => ({
  body,
  status,
});

export const tunnelFail = <T>(body: T, status: number) =>
  Effect.fail(new TunnelRouteError({ body, status }));

export const attemptTunnel = <A>(
  operation: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => cause,
  });

export const attemptTunnelSync = <A>(
  operation: () => A,
): Effect.Effect<A, unknown> =>
  Effect.try({
    try: operation,
    catch: (cause) => cause,
  });

export const parseJsonBody = <A = Record<string, unknown>>(
  c: any,
): Effect.Effect<A, unknown> =>
  attemptTunnel(async () => (await c.req.json()) as A);

export const parseOptionalJsonBody = <A = Record<string, unknown>>(
  c: any,
  fallback: A,
): Effect.Effect<A, never> =>
  Effect.promise(async () => {
    try {
      return (await c.req.json()) as A;
    } catch {
      return fallback;
    }
  });

export async function runTunnelEffect<A, E>(
  effect: Effect.Effect<TunnelJsonResponse<A>, E>,
): Promise<TunnelJsonResponse<A>> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isRight(result)) return result.right;

  const error = result.left;
  if (error instanceof TunnelRouteError) {
    return tunnelJson(error.body as A, error.status);
  }

  if (error instanceof HTTPException) {
    throw error;
  }

  throw error;
}

export const sendTunnelJson = (
  c: any,
  response: TunnelJsonResponse,
): any => c.json(response.body as any, response.status as any);
