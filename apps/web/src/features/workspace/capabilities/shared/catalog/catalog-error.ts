/**
 * What a failed catalog load should actually say.
 *
 * Every one of these surfaces used to print "Couldn't load — Check your
 * connection and try again." for any failure at all. For a `500` that sentence
 * is not vague, it is **wrong**: it names a cause (the user's network) that has
 * been ruled out by the fact that a response came back at all, and it sends the
 * one person who could report the fault off to check their wifi instead.
 *
 * The API deliberately returns an opaque body on a 500 (`apps/api/src/index.ts`
 * → `{"error":true,"message":"Internal server error"}`) so schema and table
 * names never reach a client, and that is right — the real cause is in the
 * server log, with `pgCode`, `schema` and `table` attached. So this does not
 * try to explain the failure. It only has to stop misattributing it, and say
 * whether retrying is worth the user's time.
 */

/** The status a failed request came back with, if it came back at all. Reads
 *  `ApiError.status` (`packages/sdk/.../http/api/errors.ts`) without importing
 *  the class — a `instanceof` check across the SDK's ESM build and its IIFE
 *  global can be `false` for the very same error (the dual-package hazard the
 *  SDK's own guide calls out), and this copy is not worth that risk. */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

export interface CatalogErrorCopy {
  title: string;
  description: string;
  /** Whether to offer Retry. Hidden where pressing it cannot change the
   *  outcome, so the button never becomes the thing that lies instead. */
  canRetry: boolean;
}

export function catalogErrorCopy(error: unknown): CatalogErrorCopy {
  const status = statusOf(error);

  // No status: the request never completed. This is the ONLY case where the
  // user's connection is a fair thing to point at.
  if (status === null) {
    return {
      title: "Couldn't load",
      description: 'Check your connection and try again.',
      canRetry: true,
    };
  }

  if (status === 401) {
    return {
      title: 'Session expired',
      description: 'Sign in again to continue.',
      canRetry: false,
    };
  }

  if (status === 403) {
    return {
      title: 'No access',
      description: "You don't have permission to view this.",
      canRetry: false,
    };
  }

  if (status === 404) {
    return {
      title: 'Not found',
      description: 'This has been moved or deleted.',
      canRetry: false,
    };
  }

  if (status >= 500) {
    return {
      title: 'Server error',
      description: `The server failed to answer (${status}). Retrying may work; the details are in the server log.`,
      canRetry: true,
    };
  }

  return {
    title: "Couldn't load",
    description: `The request was rejected (${status}).`,
    canRetry: false,
  };
}
