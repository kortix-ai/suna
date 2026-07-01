import { Data, Effect, Either } from 'effect';
import { HTTPException } from 'hono/http-exception';

export class ApiEffectError extends Data.TaggedError('ApiEffectError')<{
  readonly status: number;
  readonly message: string;
  readonly code?: string;
  readonly cause?: unknown;
}> {}

export const httpFail = (
  status: number,
  message: string,
  options?: { code?: string; cause?: unknown },
) =>
  Effect.fail(
    new ApiEffectError({
      status,
      message,
      code: options?.code,
      cause: options?.cause,
    }),
  );

export async function runEffectOrThrow<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
}

export function throwHttp(error: unknown): never {
  if (error instanceof HTTPException) {
    throw error;
  }
  if (error instanceof ApiEffectError) {
    throw new HTTPException(error.status as never, {
      message: error.message,
    });
  }
  throw error;
}

export async function runHttpEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  try {
    return await runEffectOrThrow(effect);
  } catch (error) {
    throwHttp(error);
  }
}
