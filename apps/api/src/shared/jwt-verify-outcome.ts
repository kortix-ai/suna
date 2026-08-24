/**
 * How to read a local JWT verification failure.
 *
 * This lives apart from `jwt-verify.ts` on purpose. That module owns the JWKS
 * cache and kicks off a fetch on import, and five test files replace it wholesale
 * with `mock.module('../shared/jwt-verify', ...)`. Anything the auth middlewares
 * import from there has to exist in every one of those hand-written mocks, and a
 * predicate re-stated in five places is exactly the drift this function exists to
 * prevent. Keeping it in a side-effect-free module means the middlewares can rely
 * on the real implementation even when the verifier itself is mocked.
 */

/**
 * Did local verification fail because it could not reach a verdict, rather than
 * because the token is bad?
 *
 * Inconclusive means "this verifier cannot judge it" — JWKS not loaded, no key
 * for this `kid`, or an algorithm it does not implement (a symmetric HS* token,
 * which only the auth server can check). Those must fall through to the network
 * path. Everything else — bad signature, expired, malformed — is a real verdict
 * and must be rejected.
 *
 * Both auth middlewares route on this ONE predicate so they cannot drift apart.
 */
export function isInconclusiveVerifyFailure(reason: string): boolean {
  return (
    reason === 'no-keys' || reason === 'no-key-for-kid' || reason.startsWith('unsupported-alg')
  );
}
