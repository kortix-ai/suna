/**
 * 13 — One Kortix member on every runtime: verify a token, gate by group.
 *
 * A Kortix Backend (or any server holding the KORTIX_AUTH_* env Kortix writes
 * into it) receives a 15-minute token naming the member. This example plays a
 * tiny HTTP server: it verifies the bearer, then lets only the Finance group
 * read a report. In a Convex function the same check is one line:
 *   requireKortixMember(await ctx.auth.getUserIdentity(), { groups: ['Finance'] })
 *
 * Run (needs a backend's env and a token from `kortix backends token main`):
 *   KORTIX_AUTH_JWKS=... KORTIX_AUTH_ISSUER=... KORTIX_AUTH_AUDIENCE=... \
 *   TOKEN=$(kortix backends token main) bun run examples/13-kortix-members.ts
 *
 * As an npm consumer the only import line changes:
 *   import { verifyKortixMemberToken, requireKortixMember, KortixMemberError } from '@kortix/sdk';
 */
import { KortixMemberError, requireKortixMember, verifyKortixMemberToken } from '../src/index';

/** The whole server: 401 for nobody, 403 outside Finance, the report otherwise. */
async function handle(request: Request): Promise<Response> {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  try {
    const member = requireKortixMember(await verifyKortixMemberToken(bearer), { groups: ['Finance'] });
    return Response.json({ report: 'Q4 revenue', for: member.name ?? member.email, groups: member.groups });
  } catch (error) {
    if (error instanceof KortixMemberError) {
      return Response.json({ error: error.message }, { status: error.code === 'forbidden' ? 403 : 401 });
    }
    throw error;
  }
}

const token = process.env.TOKEN ?? '';
const response = await handle(new Request('http://local/report', { headers: { authorization: `Bearer ${token}` } }));
console.log(response.status, await response.json());
