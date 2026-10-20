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
    // Sign-in works before the email is verified; joining an organization does
    // not (see organization() below). ponytail: the example has no email
    // provider, so the verification link goes to the Convex log
    // (`npx convex logs`). Production sends it with its email provider here.
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 10 },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        console.log(`[lumen] verify ${user.email}: ${url}`);
      },
    },
    plugins: [
      // Invitations are shared as a link (/invite/<id>). The recipient must sign
      // in with the invited email AND have verified it, so someone who
      // registers that address first, and holds the link, cannot join.
      organization({ requireEmailVerificationOnInvitation: true }),
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
