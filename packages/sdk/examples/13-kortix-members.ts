/**
 * 13 — One Kortix member on every runtime: verify a token, gate by group.
 *
 * Any server of a Kortix App receives a 15-minute token naming the member,
 * signed by the project issuer for that App (`aud` = the App id). This example
 * plays a tiny HTTP server: it verifies the bearer, then lets only the Finance
 * group read a report. In a Convex function the same check is one line:
 *   requireKortixMember(await ctx.auth.getUserIdentity(), { groups: ['Finance'] })
 *
 * Run with the App's `auth` values (`kortix apps show <app> --json`) and a token:
 *   KORTIX_AUTH_JWKS=<auth.jwks_uri> KORTIX_AUTH_ISSUER=<auth.issuer> KORTIX_AUTH_AUDIENCE=<auth.audience> \
 *   TOKEN=$(kortix apps token <app>) bun run examples/13-kortix-members.ts
 *
 * As an npm consumer the only import line changes:
 *   import { verifyKortixToken, requireKortixMember, KortixMemberError } from '@kortix/sdk';
 */
import { KortixMemberError, requireKortixMember, verifyKortixToken } from '../src/index';

/** The whole server: 401 for nobody, 403 outside Finance, the report otherwise. */
async function handle(request: Request): Promise<Response> {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  try {
    const member = requireKortixMember(await verifyKortixToken(bearer), { groups: ['Finance'] });
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
