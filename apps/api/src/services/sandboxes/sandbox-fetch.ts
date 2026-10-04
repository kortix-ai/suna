/**
 * Bun can advertise zstd/br when it fetches a sandbox preview, while some
 * provider proxies return a body Bun cannot decode. Server-to-sandbox reads
 * use identity encoding so JSON session/message responses stay portable.
 */
export function sandboxRuntimeRequestHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return { ...headers, 'Accept-Encoding': 'identity' };
}
