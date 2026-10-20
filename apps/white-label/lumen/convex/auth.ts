import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { v } from "convex/values";
import { APIError } from "better-auth/api";
import type { FunctionReference } from "convex/server";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/schema";
import { seatAvailable } from "./seats";

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
});

/** Better Auth's "member" role is a "lawyer" in Lumen's words. */
const roleWord = (r: string) => (r === "member" ? "lawyer" : r);

type AuditAction = "member.invite" | "member.join" | "member.role" | "member.remove" | "member.invite_cancel";

/** Better Auth runs inside Convex HTTP actions here, so ctx can run Lumen's own functions. */
function runner(ctx: GenericCtx<DataModel>) {
  const c = ctx as { runQuery?: (f: FunctionReference<"query", "internal">, a: object) => Promise<any>; runMutation?: (f: FunctionReference<"mutation", "internal">, a: object) => Promise<any> };
  return {
    query: (f: FunctionReference<"query", "internal">, a: object) => (c.runQuery ? c.runQuery(f, a) : Promise.resolve(null)),
    log: async (orgId: string, actorId: string, action: AuditAction, detail?: string) => {
      if (c.runMutation) await c.runMutation(internal.audit.logOrgEvent, { orgId, actorId, action, detail });
    },
  };
}

/** Lumen's rules on Better Auth's organization events: the seat limit, and an audit row for each change. */
function organizationHooks(ctx: GenericCtx<DataModel>) {
  const run = runner(ctx);
  return {
    beforeCreateInvitation: async ({ invitation }: { invitation: { organizationId: string } }) => {
      const s = await run.query(internal.billing.seatState, { orgId: invitation.organizationId });
      if (s && !seatAvailable(s.seats, s.members, s.pending)) {
        throw new APIError("FORBIDDEN", { message: `All ${s.seats} seats are in use. Add seats to invite more people.` });
      }
    },
    afterCreateInvitation: async ({ invitation, inviter }: { invitation: { organizationId: string; email: string; role: string }; inviter: { id: string } }) =>
      run.log(invitation.organizationId, inviter.id, "member.invite", `${invitation.email} as ${roleWord(invitation.role)}`),
    afterAcceptInvitation: async ({ member, user }: { member: { organizationId: string; role: string }; user: { id: string; email: string } }) =>
      run.log(member.organizationId, user.id, "member.join", `${user.email} as ${roleWord(member.role)}`),
    afterUpdateMemberRole: async ({ member, previousRole, user }: { member: { organizationId: string; role: string; userId: string }; previousRole: string; user: { id: string; email: string } }) =>
      run.log(member.organizationId, member.userId, "member.role", `${user.email}: ${roleWord(previousRole)} → ${roleWord(member.role)}`),
    afterRemoveMember: async ({ member, user }: { member: { organizationId: string; userId: string }; user: { email: string } }) =>
      run.log(member.organizationId, member.userId, "member.remove", user.email),
    afterCancelInvitation: async ({ invitation, cancelledBy }: { invitation: { organizationId: string; email: string }; cancelledBy: { id: string } }) =>
      run.log(invitation.organizationId, cancelledBy.id, "member.invite_cancel", invitation.email),
  };
}

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
      organization({ requireEmailVerificationOnInvitation: true, organizationHooks: organizationHooks(ctx) }),
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
