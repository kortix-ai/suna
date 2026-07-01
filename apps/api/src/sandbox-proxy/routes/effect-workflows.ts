import { Data, Effect, Either } from "effect";

type HttpStatus = number;

export type ProxyRouteResponse<A = unknown> =
  | { readonly kind: "json"; readonly body: A; readonly status: HttpStatus }
  | { readonly kind: "response"; readonly response: Response };

export class ProxyRouteJsonError extends Data.TaggedError(
  "ProxyRouteJsonError",
)<{
  readonly body: unknown;
  readonly status: HttpStatus;
}> {}

export const jsonResult = <A>(
  body: A,
  status: HttpStatus = 200,
): ProxyRouteResponse<A> => ({ kind: "json", body, status });

export const responseResult = (response: Response): ProxyRouteResponse => ({
  kind: "response",
  response,
});

export const failJson = (
  body: unknown,
  status: HttpStatus,
): Effect.Effect<never, ProxyRouteJsonError> =>
  Effect.fail(new ProxyRouteJsonError({ body, status }));

export const attemptProxy = <A>(
  operation: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => cause,
  });

export const attemptProxySync = <A>(
  operation: () => A,
): Effect.Effect<A, unknown> =>
  Effect.try({
    try: operation,
    catch: (cause) => cause,
  });

export const parseJsonBody = <A>(
  c: any,
  invalidBody: unknown,
  invalidStatus = 400,
): Effect.Effect<A, ProxyRouteJsonError | unknown> =>
  Effect.tryPromise({
    try: async () => (await c.req.json()) as A,
    catch: () =>
      new ProxyRouteJsonError({ body: invalidBody, status: invalidStatus }),
  });

export async function runProxyRouteEffect<A>(
  c: any,
  effect: Effect.Effect<ProxyRouteResponse<A>, unknown>,
) {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isRight(result)) {
    const response = result.right;
    if (response.kind === "response") return response.response;
    return c.json(response.body, response.status as any);
  }

  const error = result.left;
  if (error instanceof ProxyRouteJsonError) {
    return c.json(error.body, error.status as any);
  }
  throw error;
}

export async function runProxyValueEffect<A>(
  c: any,
  effect: Effect.Effect<A, unknown>,
): Promise<
  | { readonly kind: "value"; readonly value: A }
  | { readonly kind: "response"; readonly response: Response }
> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isRight(result)) {
    return { kind: "value", value: result.right };
  }

  const error = result.left;
  if (error instanceof ProxyRouteJsonError) {
    return {
      kind: "response",
      response: c.json(error.body, error.status as any),
    };
  }
  throw error;
}
