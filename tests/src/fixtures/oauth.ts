/**
 * OAuth wire shapes shared by the MCP and OAuth flows: the form-encoded token
 * request body and an RFC 7636 PKCE verifier/challenge pair.
 */

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}
