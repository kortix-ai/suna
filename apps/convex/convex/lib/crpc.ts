import { CRPCError } from 'kitcn/server';
import type { ActionCtx, MutationCtx, QueryCtx } from '../functions/generated/server';
import { initCRPC } from '../functions/generated/server';

const c = initCRPC
  .meta<{
    auth?: 'optional' | 'required';
  }>()
  .create();

type IdentityUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

function requireAuth<T>(user: T | null): T {
  if (!user) {
    throw new CRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }

  return user;
}

async function getIdentityUser(
  ctx: QueryCtx | MutationCtx | ActionCtx
): Promise<IdentityUser | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }

  return {
    id: identity.subject,
    email: identity.email,
    name: identity.name,
  };
}

export const publicQuery = c.query;
export const publicAction = c.action;
export const publicMutation = c.mutation;

export const privateQuery = c.query.internal();
export const privateMutation = c.mutation.internal();
export const privateAction = c.action.internal();

export const optionalAuthQuery = c.query
  .meta({ auth: 'optional' })
  .use(async ({ ctx, next }) => {
    const user = await getIdentityUser(ctx);

    return next({
      ctx: {
        ...ctx,
        user,
        userId: user?.id ?? null,
      },
    });
  });

export const authQuery = c.query
  .meta({ auth: 'required' })
  .use(async ({ ctx, next }) => {
    const user = requireAuth(await getIdentityUser(ctx));

    return next({
      ctx: {
        ...ctx,
        user,
        userId: user.id,
      },
    });
  });

export const optionalAuthMutation = c.mutation
  .meta({ auth: 'optional' })
  .use(async ({ ctx, next }) => {
    const user = await getIdentityUser(ctx);

    return next({
      ctx: {
        ...ctx,
        user,
        userId: user?.id ?? null,
      },
    });
  });

export const authMutation = c.mutation
  .meta({ auth: 'required' })
  .use(async ({ ctx, next }) => {
    const user = requireAuth(await getIdentityUser(ctx));

    return next({
      ctx: {
        ...ctx,
        user,
        userId: user.id,
      },
    });
  });

export const authAction = c.action
  .meta({ auth: 'required' })
  .use(async ({ ctx, next }) => {
    const user = requireAuth(await getIdentityUser(ctx));

    return next({
      ctx: {
        ...ctx,
        user,
        userId: user.id,
      },
    });
  });

export const publicRoute = c.httpAction;
export const authRoute = c.httpAction.use(async ({ ctx, next }) => {
  const user = requireAuth(await getIdentityUser(ctx));

  return next({
    ctx: {
      ...ctx,
      user,
      userId: user.id,
    },
  });
});
export const optionalAuthRoute = c.httpAction.use(async ({ ctx, next }) => {
  const user = await getIdentityUser(ctx);

  return next({
    ctx: {
      ...ctx,
      user,
      userId: user?.id ?? null,
    },
  });
});
export const router = c.router;
