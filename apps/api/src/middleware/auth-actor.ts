import { Context, Next } from 'hono';
import { buildActor } from '../iam/actor';

export async function withActor(c: Context, next: Next) {
  try {
    const actor = await buildActor(c);
    if (actor) c.set('actor', actor);
  } catch (err) {
    console.warn('[auth] failed to build IAM actor', err);
  }
  await next();
}
