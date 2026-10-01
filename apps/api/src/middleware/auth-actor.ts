import { Context, Next } from 'hono';
import { buildActor } from '../iam/actor';
import { credentialFromContext } from '../shared/audit-credential';
import { bindAuditPrincipal } from '../shared/audit-scope';

export async function withActor(c: Context, next: Next) {
  // Every authenticator has run: name the credential for the audit rows this request writes.
  bindAuditPrincipal(credentialFromContext((key) => c.get(key)));
  try {
    const actor = await buildActor(c);
    if (actor) c.set('actor', actor);
  } catch (err) {
    console.warn('[auth] failed to build IAM actor', err);
  }
  await next();
}
