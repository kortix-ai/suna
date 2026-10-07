# Kortix sign-in for backends

Every Kortix backend trusts Kortix as its identity provider. You build no login
screen, no user table and no invite flow: the people who use the App are the
project's Kortix members, with their real names and their Kortix groups.

`@kortix/sdk` reads and enforces that identity in three lines. The same
functions work in a Convex function, a Node or Bun server, a Worker and the
browser.

```sh
npm i @kortix/sdk          # in the backend and in the App
```

If `requireKortixMember` is not exported, the installed SDK is too old:
`npm i @kortix/sdk@latest`.

## How it works

1. **Front door.** The App's access policy (`private`, `project`,
   `restricted` to members or groups) decides who may open the App. Kortix
   checks it on every page load.
2. **Identity.** For each signed-in member, Kortix signs a 15-minute ES256
   token for one backend. Its claims are the member: `sub` (Kortix user id),
   `email`, `name`, `picture`, `groups` (Kortix group names in the account),
   `group_ids`, `role` (account role: `owner`, `admin` or `member`),
   `account_id`, `project_id`. A token for one backend is useless on another.
3. **Data rules.** Your functions decide what each member may read and
   write, with `requireKortixMember`. The backend URL is public, so this is
   the only security boundary that counts. The App's UI never is.

Kortix writes the public key into the backend's environment at creation:
`KORTIX_AUTH_ISSUER`, `KORTIX_AUTH_AUDIENCE`, `KORTIX_AUTH_JWKS` (inline; the
backend fetches nothing).

## Backend: accept the token

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

## Backend: require a member

```ts
// convex/lib/auth.ts
import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";
import { requireKortixMember, type KortixMemberRequirement } from "@kortix/sdk";

/** Every public function calls this first. Throws for anyone it refuses. */
export async function requireMember(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  requirement?: KortixMemberRequirement,
) {
  const member = requireKortixMember(await ctx.auth.getUserIdentity(), requirement);
  return { ...member, name: member.name ?? member.email ?? "Member" };
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

// Only the Finance group: by group name (or id).
export const revenue = query({
  args: {},
  handler: async (ctx) => {
    await requireMember(ctx, { groups: ["Finance"] });
    // …
  },
});

// Only account owners and admins.
export const removeCompany = mutation({
  args: { id: v.id("companies") },
  handler: async (ctx, { id }) => {
    await requireMember(ctx, { roles: ["owner", "admin"] });
    await ctx.db.delete(id);
  },
});
```

`requireKortixMember` throws a `KortixMemberError` with `code`
`unauthenticated` (nobody) or `forbidden` (a member outside the groups or
roles). Each list means "any one of these"; an empty list admits nobody.

Rules that work:

- Store `me.userId` (stable) as the owner, never the email.
- Denormalize the display name onto rows the UI lists.
- Per-row ownership ("only the deal's owner edits it") is your code:
  compare `me.userId` with the row's owner.
- Group access uses the same Kortix groups as the App's access policy. Add
  someone to a group in Kortix and they gain the matching rights within 15
  minutes (one token lifetime), with no change to the App.

## App: send the token

```ts
// src/convex.ts
import { ConvexReactClient } from "convex/react";
import { kortixAppBackendToken } from "@kortix/sdk";

export const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
convex.setAuth(kortixAppBackendToken("main"));   // the backend's name
```

`kortixAppBackendToken` fetches `GET /_kortix/backend-token?backend=main` on
the App's own origin, caches the token and refreshes it before it expires. It
yields `null` (anonymous) when nobody is signed in. It costs under 1 kB in the
App bundle.

Show who is signed in with a query, so the UI and the backend agree:

```ts
// convex/members.ts
import { readKortixMember } from "@kortix/sdk";
export const me = query({
  args: {},
  handler: async (ctx) => {
    const member = readKortixMember(await ctx.auth.getUserIdentity());
    return member && { ...member, name: member.name ?? member.email ?? "Member" };
  },
});
```

A static App without a backend can ask the gate directly:
`fetchKortixAppViewer()` returns the same member (name, picture, groups,
role) from `/_kortix/viewer`.

## Any other server

A server that receives the token itself (an App's own API, a Worker) verifies
it with the same SDK. With no options it reads `KORTIX_AUTH_JWKS`,
`KORTIX_AUTH_ISSUER` and `KORTIX_AUTH_AUDIENCE`:

```ts
import { verifyKortixMemberToken, requireKortixMember, KortixMemberError } from "@kortix/sdk";

const member = await verifyKortixMemberToken(bearerToken);   // throws KortixMemberError
requireKortixMember(member, { groups: ["Finance"] });
```

## Who gets a token

| Caller | How | Notes |
| --- | --- | --- |
| A person using a Kortix App | `kortixAppBackendToken("<name>")` (wraps `GET /_kortix/backend-token?backend=<name>` on the App's own origin) | Needs a signed-in viewer: access `private`, `project` or `restricted`, and `--viewer` not `off`. A `public` or `password` App gets `401`. |
| You (an agent) or a script | `kortix backends token <name>` · `POST /v1/projects/{projectId}/backends/{backendId}/token` · SDK `kortix.project(id).backends.token(backendId)` | Names the caller, with groups and role. |
| Admin tooling | `npx convex run --identity '{"subject":"…","groups":["Finance"]}' fn args` | Admin key only; for testing auth rules. |

An agent session that opens an App's `/_kortix/backend-token` gets `403
agent_viewer`: it must not act as the person who launched it. Use
`kortix backends token` instead.

## People who are not Kortix members

Kortix sign-in is for the project's own people. When the App serves customers
or the public, add a second provider inside the backend (Convex Auth for
password, magic link or OAuth; or Clerk, WorkOS) next to the Kortix provider
in `auth.config.ts`. Staff keep Kortix sign-in; customers get their own
accounts; both reach the same functions. Distinguish them by
`identity.issuer`.

## Groups

Kortix groups belong to an account and need the Enterprise plan. Without
groups, use `roles` (`owner`, `admin`, `member`) or your own roles table keyed
on `userId`.

## Test it

```sh
eval "$(kortix backends env main)" && cd backends/main
npx convex run tasks:list '{}'      # admin, no identity → your function must reject
npx convex run --identity '{"subject":"u1","email":"a@example.com","name":"A","groups":["Finance"]}' tasks:create '{"title":"x"}'
kortix backends token main          # a real token naming you, with your groups
```

A function that returns data for an anonymous call is a bug. Fix it before you
ship.
