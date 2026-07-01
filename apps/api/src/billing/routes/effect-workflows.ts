import { Data, Effect, Either } from 'effect';
import { HTTPException } from 'hono/http-exception';
import { BillingError } from '../../errors';

type RouteErrorKind = 'billing' | 'http' | 'unknown';

export class BillingRouteError extends Data.TaggedError('BillingRouteError')<{
  readonly kind: RouteErrorKind;
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toRouteError = (cause: unknown): BillingRouteError => {
  if (cause instanceof BillingError) {
    return new BillingRouteError({
      kind: 'billing',
      status: cause.statusCode,
      message: cause.message,
      cause,
    });
  }

  if (cause instanceof HTTPException) {
    return new BillingRouteError({
      kind: 'http',
      status: cause.status,
      message: cause.message,
      cause,
    });
  }

  return new BillingRouteError({
    kind: 'unknown',
    status: 500,
    message: errorMessage(cause),
    cause,
  });
};

export const billingFail = (message: string, status = 400) =>
  Effect.fail(new BillingRouteError({ kind: 'billing', status, message }));

export const attemptBilling = <A>(
  operation: () => Promise<A>,
): Effect.Effect<A, BillingRouteError> =>
  Effect.tryPromise({
    try: operation,
    catch: toRouteError,
  });

export const attemptBillingSync = <A>(
  operation: () => A,
): Effect.Effect<A, BillingRouteError> =>
  Effect.try({
    try: operation,
    catch: toRouteError,
  });

export const parseJsonBody = <A = Record<string, unknown>>(
  c: any,
): Effect.Effect<A, BillingRouteError> =>
  attemptBilling(async () => (await c.req.json()) as A);

export const parseOptionalJsonBody = <A = Record<string, unknown>>(
  c: any,
  fallback: A,
): Effect.Effect<A, BillingRouteError> =>
  attemptBilling(async () => {
    try {
      return (await c.req.json()) as A;
    } catch {
      return fallback;
    }
  });

export async function runBillingEffect<A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isRight(result)) return result.right;

  const error = result.left;
  if (error instanceof BillingRouteError) {
    if (error.kind === 'billing') {
      throw new BillingError(error.message, error.status);
    }

    if (error.kind === 'http') {
      throw new HTTPException(error.status as never, { message: error.message });
    }

    if (error.cause instanceof Error) throw error.cause;
    throw new Error(error.message);
  }

  throw error;
}
