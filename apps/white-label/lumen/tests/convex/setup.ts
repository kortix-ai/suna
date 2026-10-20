import { convexTest } from 'convex-test';
import { components } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import authSchema from '../../convex/betterAuth/schema';

const modules = import.meta.glob(['../../convex/**/*.ts', '!../../convex/betterAuth/**']);
const authModules = import.meta.glob('../../convex/betterAuth/**/*.ts');

// Vite's import.meta.glob, typed here: vite itself is not a direct dependency.
declare global {
  interface ImportMeta {
    glob(pattern: string | string[]): Record<string, () => Promise<any>>;
  }
}

export const PROXY_SECRET = 'test-proxy-secret';

/** A fresh in-memory Lumen backend with the Better Auth component. */
export function lumenTest() {
  process.env.KORTIX_UPSTREAM = 'https://kortix.test/v1';
  process.env.KORTIX_OPERATOR_TOKEN = 'kortix_pat_operator';
  process.env.LUMEN_PROXY_SECRET = PROXY_SECRET;
  const t = convexTest(schema, modules);
  t.registerComponent('betterAuth', authSchema, authModules);
  return t;
}

type T = ReturnType<typeof lumenTest>;

async function create(t: T, model: string, data: Record<string, unknown>): Promise<string> {
  const doc = (await t.mutation(components.betterAuth.adapter.create, { input: { model, data } } as never)) as { _id: string };
  return doc._id;
}

/** A Better Auth user with a live session, as the Convex JWT names them. */
export async function signedInUser(t: T, email: string) {
  const now = Date.now();
  const userId = await create(t, 'user', { name: email, email, emailVerified: true, createdAt: now, updatedAt: now });
  const sessionId = await create(t, 'session', {
    token: `tok-${email}`, userId, expiresAt: now + 3_600_000, createdAt: now, updatedAt: now,
  });
  return { userId, as: t.withIdentity({ subject: userId, sessionId }) };
}

export async function org(t: T, name: string) {
  return create(t, 'organization', { name, slug: name.toLowerCase().replace(/\s+/g, '-'), createdAt: Date.now() });
}

export async function addMember(t: T, organizationId: string, userId: string, role = 'member') {
  return create(t, 'member', { organizationId, userId, role, createdAt: Date.now() });
}
