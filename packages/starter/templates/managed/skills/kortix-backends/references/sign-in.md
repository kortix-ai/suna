# Kortix sign-in for backends

Every Kortix backend trusts Kortix as its identity provider. No auth library,
no login screen, no user table to build.

## How it works

1. At creation, Kortix gives the backend its own ES256 signing key and writes
   the public half into the backend's environment: `KORTIX_AUTH_ISSUER`,
   `KORTIX_AUTH_AUDIENCE`, `KORTIX_AUTH_JWKS` (an inline JWKS; the backend
   fetches nothing).
2. `convex/auth.config.ts` (below) tells Convex to accept tokens with that
   issuer, audience and key.
3. Kortix mints one-hour tokens naming a member: `sub` = Kortix user id,
   `email`, `name`. A token for one backend is useless on another.
4. In a function, `await ctx.auth.getUserIdentity()` returns
   `{ subject, email, name, tokenIdentifier, … }`, or `null` when the call
   carries no valid token.

```ts
// convex/auth.config.ts — copy as is
export default {
  providers: [
    {
      type: "customJwt",
      issuer: process.env.KORTIX_AUTH_ISSUER!,
      applicationID: process.env.KORTIX_AUTH_AUDIENCE!,
      jwks: process.env.KORTIX_AUTH_JWKS!,
      algorithm: "ES256",
    },
  ],
};
```

## Who gets a token

| Caller | How | Notes |
| --- | --- | --- |
| A person using a Kortix App | `GET /_kortix/backend-token?backend=<name>` on the **App's own origin** | Uses the visitor's Kortix sign-in on the App. Works for Apps with access `private`, `project` or `restricted` (the default `viewer` setting). A `public` or `password` App has no signed-in member → `401`. |
| You (an agent) or a script | `kortix backends token <name>` · `POST /v1/projects/{projectId}/backends/{backendId}/token` · SDK `kortix.project(id).backends.token(backendId)` | Names the caller. Needs read access to backends. |
| Admin tooling | `npx convex run --identity '{"subject":"…"}' fn args` | Admin key only; for testing auth rules. |

An agent session that opens an App's `/_kortix/backend-token` gets `403
agent_viewer`: it must not act as the person who launched it. Use
`kortix backends token` instead.

## Require a signed-in member

The backend URL is public. Treat every public query, mutation and action as
reachable by anyone on the internet and check the caller first. Copy this
helper:

```ts
// convex/lib/auth.ts
import { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

export async function requireMember(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  return {
    userId: identity.subject,
    email: identity.email ?? null,
    name: identity.name ?? identity.email ?? "Member",
  };
}
```

```ts
export const create = mutation({
  args: { title: v.string() },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const me = await requireMember(ctx);
    return await ctx.db.insert("tasks", { title: args.title, createdBy: me.userId, createdByName: me.name });
  },
});
```

Store `identity.subject` (stable) as the owner, not the email. Denormalize the
display name onto rows the UI lists, so a list renders without a join. Every
member of the App's audience is a member of the backend's audience: add your
own roles table when the app needs admins vs. members.

## React wiring (App side)

```tsx
// src/convex.ts
import { ConvexReactClient } from "convex/react";

export const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

convex.setAuth(async () => {
  const res = await fetch("/_kortix/backend-token?backend=main", { credentials: "include" });
  if (!res.ok) return null;          // not signed in: functions see no identity
  const body = (await res.json()) as { token: string };
  return body.token;
});
```

```tsx
// src/main.tsx
import { ConvexProvider } from "convex/react";
import { convex } from "./convex";
// <ConvexProvider client={convex}><App /></ConvexProvider>
```

The Convex client calls the fetcher again before the token expires. Show the
member's name in the UI with a query that returns
`(await ctx.auth.getUserIdentity())?.name`, so the UI and the backend agree on
who is signed in.

## Test it

```sh
eval "$(kortix backends env main)" && cd backends/main
npx convex run tasks:list '{}'                                    # admin, no identity → your function should reject
npx convex run --identity '{"subject":"u1","email":"a@example.com","name":"A"}' tasks:create '{"title":"x"}'
```

A function that returns data for an anonymous call is a bug. Fix it before you
ship.
