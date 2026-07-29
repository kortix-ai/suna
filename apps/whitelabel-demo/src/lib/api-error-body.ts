/**
 * Pull the server's error body out of whatever the SDK threw.
 *
 * The SDK's `ApiError` carries the parsed body on `data` / `details`, lifts
 * `code` to the top level, and has **no `body` field at all**
 * (`core/http/api/errors.ts`). Demo code that read `err.body` therefore never
 * fired: every Kortix-as-a-Backend refusal — the connector prompt, the agent
 * switch conflict, the per-end-user cap — collapsed into one generic message,
 * and the classifiers written to handle them were dead code.
 *
 * Reading through one function means the next classifier cannot get this wrong.
 */
export interface ServerErrorBody {
  code?: unknown;
  error?: unknown;
  connector?: unknown;
  /** The parsed body itself. Refusals carry fields specific to their code —
   *  `requested_agent`, `expected_agent`, … — and a classifier that needs one
   *  should read it here instead of re-parsing the error. */
  raw?: Record<string, unknown>;
}

export function serverErrorBody(err: unknown): ServerErrorBody | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;

  const candidate = [e.data, e.details, e.detail].find(
    (v) => v && typeof v === 'object' && !Array.isArray(v),
  ) as Record<string, unknown> | undefined;

  // `code` is lifted onto the error itself, so it can be present even when the
  // body did not parse. Prefer the body's own code, fall back to the lifted one.
  const code = candidate?.code ?? e.code;
  // ApiError.message is always coerced to a string and holds the server's
  // `error`/`detail` text, so it is a usable fallback when the body is absent.
  const error = candidate?.error ?? (typeof e.message === 'string' ? e.message : undefined);

  if (code === undefined && error === undefined && !candidate) return null;
  return { code, error, connector: candidate?.connector, raw: candidate };
}
