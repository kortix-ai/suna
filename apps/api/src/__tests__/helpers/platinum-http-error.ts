/**
 * The error `platinumJson` throws for a non-2xx (`PlatinumHttpError`), for
 * tests that mock `services/sandboxes/platinum/client` and so cannot construct the real class.
 * Status, body and the body's `code` are read from the historical message.
 */
export function platinumHttpError(message: string): Error & { status: number; code?: string; body: string } {
  const [, status = '0', body = ''] = /-> (\d{3}) ?([\s\S]*)$/.exec(message) ?? [];
  let code: unknown;
  try {
    code = (JSON.parse(body) as { code?: unknown }).code;
  } catch {
    // not JSON: no code
  }
  return Object.assign(new Error(message), {
    name: 'PlatinumHttpError',
    status: Number(status),
    body,
    ...(typeof code === 'string' ? { code } : {}),
  });
}

/** A call that ran out of its budget, as `services/sandboxes/platinum/client` and `withTimeout` throw it. */
export function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { name: 'TimeoutError' });
}
