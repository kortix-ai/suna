import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { v } from "convex/values";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/schema";

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
});

export const createAuthOptions = (ctx: GenericCtx<DataModel>) =>
  ({
    baseURL: process.env.SITE_URL,
    database: authComponent.adapter(ctx),
    // ponytail: no email provider in the example. Production turns on email
    // verification and organization({ sendInvitationEmail }) and drops the
    // requireEmailVerificationOnInvitation override below.
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 10 },
    plugins: [
      // Invitations are shared as a link (/invite/<id>). The recipient must sign
      // in with the invited email; Convex ids are not guessable.
      organization({ requireEmailVerificationOnInvitation: false }),
      convex({ authConfig }),
    ],
  }) satisfies BetterAuthOptions;

export const createAuth = (ctx: GenericCtx<DataModel>) => betterAuth(createAuthOptions(ctx));

/** The signed-in user as Convex functions see it. */
export const me = query({
  args: {},
  returns: v.union(v.null(), v.object({ userId: v.string(), email: v.string() })),
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    return user ? { userId: user._id as string, email: user.email } : null;
  },
});
