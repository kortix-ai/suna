# Kortix sign-in for Apps

Every App can trust Kortix as its identity provider. You build no login
screen, no user table and no invite flow: the people who use an App are the
project's Kortix members, with their real names, Kortix groups and role.

`@kortix/sdk` mints, verifies and enforces that identity. The same functions
work in the browser, a Node or Bun server, a Worker and a Convex function.

```sh
npm i @kortix/sdk          # in every App that mints or checks a token
```

## The token

- **Issuer:** one per project, `https://<api host>/v1/projects/<project_id>`.
  `<issuer>/.well-known/openid-configuration` names `<issuer>/jwks.json`, the
  project's public ES256 key set. Both routes are public.
- **Audience:** the id of the App the token is for. A token for one App is
  useless on another.
- **Lifetime:** 15 minutes. Clients fetch a new one before it expires.
- **Claims:** `sub` (Kortix user id), `email`, `name`, `picture`, `groups`
  (Kortix group names in the account), `group_ids`, `role` (account role:
  `owner`, `admin` or `member`), `account_id`, `project_id`. An agent's token
  has `kind: "agent"`, `sub` = its service account id, no groups and no role.

Every App response carries the three values a verifier needs:
`auth.issuer`, `auth.audience` (the App id) and `auth.jwks_uri`
(`kortix apps show <app> --json`).

## Who gets a token

| Caller | How | Notes |
| --- | --- | --- |
| A person in an App | `kortixToken({ audience: "<slug>" })` in the browser. It calls `GET /_kortix/token?audience=<slug or id>` on the App's own origin. | The audience is the App itself (the default) or an App it uses (bindings.md). Needs a signed-in viewer: access `private`, `project` or `restricted`, and `--viewer` not `off`. |
| You (an agent), a script, the CLI | `kortix apps token <app>` · `POST /v1/projects/<project_id>/apps/<app_id>/token` | A person's own credential: names that person, with groups and role. An agent session: names the agent (`kind: "agent"`), never the person who started the session. |
| Admin tooling on a `convex` App | `npx convex run --identity '{"subject":"…","issuer":"<KORTIX_AUTH_ISSUER>","groups":["Finance"]}' fn args` | Admin credentials only. Use it to test auth rules. |

An agent session never gets a token that names the person who launched it.
`/_kortix/token` called with the session's own Kortix token answers
`403 agent_viewer`. A browser opened on a `kortix apps access-link` URL carries
that link's sign-in cookie, so the App gets tokens for the user the link was
minted for. That is how you test an App as a member.

The token proves who the member is, not what they may do. Every person any
App admits can get a token for every App that App uses. Check `groups` or
`roles` in every function whose data is not meant for all of them.

## SDK version

`kortixToken`, `verifyKortixToken`, `kortixBinding`, `requireKortixMember`
and `readKortixMember` are newer than `@kortix/sdk` 0.13.52 on npm. Check the
installed package:

```sh
npm view @kortix/sdk version
node -e "import('@kortix/sdk').then((m) => console.log(typeof m.kortixToken, typeof m.requireKortixMember))"   # must print: function function
```

If it prints `undefined`, the release with these helpers is not on npm yet.
Do not stop: use the fallbacks below. They read the same claims and call the
same routes. Replace them with the SDK imports when, after
`npm i @kortix/sdk@latest`, the check prints `function function`.

```ts
// convex/lib/auth.ts — fallback until @kortix/sdk exports requireKortixMember
import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

export async function requireMember(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  requirement: { groups?: string[]; roles?: string[] } = {},
) {
  const id = await ctx.auth.getUserIdentity();
  if (!id || id.issuer !== process.env.KORTIX_AUTH_ISSUER) throw new Error("Sign in with Kortix to continue.");
  const groups = (id.groups as string[] | undefined) ?? [];
  const groupIds = (id.group_ids as string[] | undefined) ?? [];
  const role = (id.role as string | undefined) ?? null;
  if (requirement.groups && !requirement.groups.some((g) => groups.includes(g) || groupIds.includes(g))) throw new Error("Forbidden.");
  if (requirement.roles && !requirement.roles.some((r) => r === role)) throw new Error("Forbidden.");
  return { userId: id.subject, email: id.email ?? null, name: id.name ?? id.email ?? "Member", groups, groupIds, role };
}
```

```ts
// src/convex.ts (App) — fallback until @kortix/sdk exports kortixBinding
import { ConvexReactClient } from "convex/react";

export const convex = new ConvexReactClient(`${location.origin}/_kortix/apps/db`);
convex.setAuth(async () => {
  const res = await fetch("/_kortix/token?audience=db", { credentials: "same-origin" });
  return res.ok ? ((await res.json()) as { token: string }).token : null;
});
```

## A `convex` App: accept the token

Kortix writes three variables into every `convex` App's environment:
`KORTIX_AUTH_ISSUER` (the project issuer), `KORTIX_AUTH_AUDIENCE` (the App
id) and `KORTIX_AUTH_JWKS` (the key set, inline: Convex fetches nothing).
`instance.auth_env` in `kortix apps show <app> --json` shows the same values.

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

## A `convex` App: require a member

```ts
// convex/lib/auth.ts
import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";
import { requireKortixMember, KortixMemberError, type KortixMemberRequirement } from "@kortix/sdk";

/** Every public function calls this first. Throws for anyone it refuses. */
export async function requireMember(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  requirement?: KortixMemberRequirement,
) {
  const identity = await ctx.auth.getUserIdentity();
  // Only a token Kortix signed names a Kortix member. Users of a second provider never pass.
  if (identity && identity.issuer !== process.env.KORTIX_AUTH_ISSUER) {
    throw new KortixMemberError("unauthenticated", "Sign in with Kortix to continue.");
  }
  const member = requireKortixMember(identity, requirement);
  return { ...member, name: member.name ?? member.email ?? "Member" };
}
```

Keep the issuer check even with one provider. `requireKortixMember` reads any
identity that has a subject: without the check, a user of a provider you add
later passes as a member.

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
roles). Each list means "any one of these". An empty list admits nobody.

Rules that work:

- Store `me.userId` (stable) as the owner, never the email.
- Denormalize the display name onto rows the UI lists.
- Per-row ownership ("only the deal's owner edits it") is your code: compare
  `me.userId` with the row's owner.
- Group access uses the same Kortix groups as the App's access policy. Add
  someone to a group in Kortix and they gain the matching rights within 15
  minutes (one token lifetime), with no change to the App.

Show who is signed in with a query, so the UI and the data agree:

```ts
// convex/members.ts
import { query } from "./_generated/server";
import { requireMember } from "./lib/auth";
export const me = query({ args: {}, handler: async (ctx) => await requireMember(ctx) });
```

## The browser: send the token

An App reaches a `convex` App it uses through its bindings mount
(bindings.md). `kortixBinding` returns the URL and a token fetcher for that
App:

```ts
// src/convex.ts
import { ConvexReactClient } from "convex/react";
import { kortixBinding } from "@kortix/sdk";

const db = kortixBinding("db");                 // the convex App's slug
export const convex = new ConvexReactClient(db.url);
convex.setAuth(db.token);
```

For any other client, `kortixToken({ audience: "db" })` returns the same
fetcher. It caches the token and fetches a new one before it expires. It
yields `null` (anonymous) for every non-200 answer: to see why, call
`/_kortix/token` yourself (Troubleshoot sign-in, below).

### Read the signed-in member in React

Do not call `useConvexAuth()`. It throws under a plain `ConvexProvider`: it
needs `ConvexProviderWithAuth`, and `kortixBinding` is not verified with that
provider. Read the member with a query instead. The query returns `null` when
nobody is signed in (`readKortixMember` never throws):

```ts
// convex/members.ts
import { query } from "./_generated/server";
import { readKortixMember } from "@kortix/sdk";

export const me = query({
  args: {},
  handler: async (ctx) => readKortixMember(await ctx.auth.getUserIdentity()),
});
```

```tsx
// src/App.tsx
const me = useQuery(api.members.me);   // undefined: loading. null: signed out. Otherwise the member.
```

Use `requireKortixMember` only in functions that must refuse an anonymous caller.

A static App without data can ask the gate directly:
`fetchKortixAppViewer()` returns the viewer (name, picture, groups, role) from
`/_kortix/viewer`, and `readKortixMember(viewer)` gives the member shape.

## Any other server: verify the token

A server that receives the token itself (a server App's own API, a Worker)
verifies it with the same SDK:

```ts
import { verifyKortixToken, requireKortixMember, KortixMemberError } from "@kortix/sdk";

// The `auth` values of the App the token is for (kortix apps show <app> --json).
const member = await verifyKortixToken(bearer, {
  issuer: auth.issuer,
  audience: auth.audience,
  jwks: auth.jwks_uri,          // fetched once per process
});                             // throws KortixMemberError
requireKortixMember(member, { groups: ["Finance"] });
```

Kortix injects `KORTIX_AUTH_ISSUER` (the project issuer), `KORTIX_AUTH_AUDIENCE`
(the App's own id) and `KORTIX_AUTH_JWKS` (the project key set, as a `data:`
URI) into every server App's runtime. `verifyKortixToken(bearer)` with no
options reads them. Do not set `KORTIX_AUTH_*` in the App's `env`: the
`KORTIX_` prefix is reserved and `kortix validate` rejects it. A server App
deployed before 2026-10-10 gets them on its next deployment. The check
covers the ES256 signature, the expiry (60 s skew), the issuer and the
audience. `KORTIX_AUTH_JWKS` takes the key set inline (JSON or a `data:`
URI) or its URL. Every failure, a missing key set included, throws.

## Groups

Kortix groups belong to an account and need the Enterprise plan. Without it,
the `groups` claim is empty and `{ groups: [...] }` refuses everyone. Use
`roles` (`owner`, `admin`, `member`) or your own roles table keyed on
`userId` instead.

## Troubleshoot sign-in

Call the route the App calls, from the App's origin, and read the code:

| Answer from `/_kortix/token` | Cause | Fix |
| --- | --- | --- |
| `401 no_viewer_identity` | No Kortix session on the request, a `password` App, or a `public` App whose viewer lost access | Open the App through Kortix or an access link; set access `private`, `project` or `restricted`. |
| `403 agent_viewer` | An agent session's own token | `kortix apps token <app>`. |
| `403 app_not_linked` | The App does not use the audience App (a new App uses none) | `kortix apps link <app> --uses <slug>`, or `uses: [<slug>]` in the App's `kortix.yaml` block. |
| `404 viewer_disabled` | The App's viewer is `off` | `kortix apps access <app> --viewer identity`. |
| `200`, but `getUserIdentity()` is `null` | `convex/auth.config.ts` is not deployed, or its env names are wrong | Deploy `auth.config.ts` as above; `npx convex env list --names-only` must list the three `KORTIX_AUTH_*` names. |
| `200`, but `requireMember` throws `unauthenticated` | The identity's issuer is not `KORTIX_AUTH_ISSUER` | A token from another provider, or an `--identity` without `"issuer"`. |
| `200`, but Convex answers `401` | The `convex` App still trusts an older issuer | Compare `npx convex env get KORTIX_AUTH_ISSUER` with `auth.issuer` in `kortix apps show <app> --json`. Kortix rewrites the three variables within minutes. Wait, then retry. |

## People who are not Kortix members

Kortix sign-in stays the sign-in for the project's own people. When an App
also serves customers or the public, add **Convex Auth** (password, magic
link, OTP or OAuth) as a second provider in the same `convex` App. Members
keep Kortix sign-in; customers get their own accounts in the App; the issuer
tells them apart. Convex's CLI does not set Convex Auth up on a self-hosted
deployment, so follow these manual steps (from labs.convex.dev/auth/setup/manual).

1. Install, in the `convex` App's directory:

   ```sh
   npm i @convex-dev/auth @auth/core@^0.41.1
   ```

2. Generate the signing keys and set them. The values never touch the
   terminal or the repo:

   ```js
   // generate-keys.mjs (run once, then delete it and the two .txt files)
   import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
   import { writeFileSync } from "node:fs";
   const keys = await generateKeyPair("RS256", { extractable: true });
   writeFileSync("jwt_private_key.txt", (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, " "));
   writeFileSync("jwks.txt", JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }] }));
   ```

   ```sh
   npm i -D jose && node generate-keys.mjs
   npx convex env set JWT_PRIVATE_KEY --from-file jwt_private_key.txt
   npx convex env set JWKS --from-file jwks.txt
   npx convex env set SITE_URL https://<customer-app-url>     # where OAuth and magic links return
   rm generate-keys.mjs jwt_private_key.txt jwks.txt
   ```

3. Add the provider next to Kortix in `convex/auth.config.ts`:

   ```ts
   export default {
     providers: [
       { type: "customJwt", issuer: process.env.KORTIX_AUTH_ISSUER!, applicationID: process.env.KORTIX_AUTH_AUDIENCE!, jwks: process.env.KORTIX_AUTH_JWKS!, algorithm: "ES256" },
       { domain: process.env.CONVEX_SITE_URL, applicationID: "convex" },   // Convex Auth
     ],
   };
   ```

4. Add `convex/auth.ts`, the HTTP routes and the tables:

   ```ts
   // convex/auth.ts
   import { convexAuth } from "@convex-dev/auth/server";
   import { Password } from "@convex-dev/auth/providers/Password";
   export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({ providers: [Password] });

   // convex/http.ts
   import { httpRouter } from "convex/server";
   import { auth } from "./auth";
   const http = httpRouter();
   auth.addHttpRoutes(http);
   export default http;

   // convex/schema.ts
   import { defineSchema } from "convex/server";
   import { authTables } from "@convex-dev/auth/server";
   export default defineSchema({ ...authTables, /* your tables */ });
   ```

   `convex/tsconfig.json` needs `"skipLibCheck": true` and
   `"moduleResolution": "Bundler"` (`npx convex codegen --init` writes both).

5. Gate customer functions on the Convex Auth issuer, the same way
   `requireMember` gates on the Kortix one:

   ```ts
   import { getAuthUserId } from "@convex-dev/auth/server";

   async function requireCustomer(ctx: QueryCtx | MutationCtx) {
     const identity = await ctx.auth.getUserIdentity();
     if (!identity || identity.issuer !== process.env.CONVEX_SITE_URL) throw new Error("Sign in to continue.");
     const userId = await getAuthUserId(ctx);
     if (!userId) throw new Error("Sign in to continue.");
     return userId;   // an Id<"users"> in this App
   }
   ```

6. The customer UI is its own App with access `public`, wrapped in
   `ConvexAuthProvider` from `@convex-dev/auth/react` (Convex's `convex-auth`
   skill), on the `convex` App's own `instance.url`. Do not call
   `kortixToken` there. Keep the staff UI a separate App with Kortix sign-in.

A customer token never passes `requireMember`, and a member token never
passes `requireCustomer`. Test both directions before you ship.

## Test it

```sh
eval "$(kortix apps credentials db)" && cd apps/db
ISS=$(npx convex env get KORTIX_AUTH_ISSUER)
npx convex run tasks:list '{}'      # admin, no identity → your function must reject
npx convex run --identity "{\"subject\":\"u1\",\"issuer\":\"$ISS\",\"email\":\"a@example.com\",\"name\":\"A\",\"groups\":[\"Finance\"]}" tasks:create '{"title":"x"}'
kortix apps token db                # a real token; in a session it names the agent (no groups, no role)
```

`--identity` without `"issuer"` uses `https://convex.test`, which
`requireMember` refuses. A function that returns data for an anonymous call is
a bug. Fix it before you ship.
