# Kortix sign-in for backends

Every Kortix backend trusts Kortix as its identity provider. You build no login
screen, no user table and no invite flow: the people who use the App are the
project's Kortix members, with their real names and their Kortix groups.

`@kortix/sdk` reads and enforces that identity. The same functions work in a
Convex function, a Node or Bun server, a Worker and the browser.

```sh
npm i @kortix/sdk          # in the backend and in the App
```

## SDK version

`requireKortixMember`, `readKortixMember` and `kortixAppBackendToken` are newer
than `@kortix/sdk` 0.13.52 on npm. Check the installed package:

```sh
npm view @kortix/sdk version
node -e "import('@kortix/sdk').then((m) => console.log(typeof m.requireKortixMember))"   # must print: function
```

If it prints `undefined`, the release with these helpers is not on npm yet.
Do not stop: use the two fallbacks below. They read the same token claims and
call the same App route as the SDK helpers. Replace them with the SDK imports when, after
`npm i @kortix/sdk@latest`, the check above prints `function`.

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
// src/convex.ts (App) — fallback until @kortix/sdk exports kortixAppBackendToken
convex.setAuth(async () => {
  const res = await fetch("/_kortix/backend-token?backend=main", { credentials: "same-origin" });
  return res.ok ? ((await res.json()) as { token: string }).token : null;
});
```

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
   write, with `requireMember`. The backend URL is public, so this is the
   only security boundary that counts. The App's UI never is.

Kortix writes the public key into the backend's environment at creation:
`KORTIX_AUTH_ISSUER`, `KORTIX_AUTH_AUDIENCE`, `KORTIX_AUTH_JWKS` (inline; the
backend fetches nothing). `KORTIX_AUTH_ISSUER` is a public URL,
`https://<api host>/v1/backends/<backend_id>`: `<issuer>/jwks.json` serves the
same public key and `<issuer>/.well-known/openid-configuration` names it. Both
need no credential.

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
roles). Each list means "any one of these"; an empty list admits nobody.

Rules that work:

- Store `me.userId` (stable) as the owner, never the email.
- Denormalize the display name onto rows the UI lists.
- Per-row ownership ("only the deal's owner edits it") is your code:
  compare `me.userId` with the row's owner.
- Group access uses the same Kortix groups as the App's access policy. Add
  someone to a group in Kortix and they gain the matching rights within 15
  minutes (one token lifetime), with no change to the App.

## App: the backend URL and the token

The backend `url` (`kortix backends get <name> --json` → `backend.url`) is
public, not secret. A static or SPA App reads it at build time: put
`VITE_CONVEX_URL=<url>` (Vite) or `NEXT_PUBLIC_CONVEX_URL=<url>` (Next.js) in
the App's committed `.env.production`, build, and deploy the built directory
(kortix-apps). A server-rendered App reads `CONVEX_URL` at runtime from the
App's `env` in `kortix.yaml`.

```ts
// src/convex.ts
import { ConvexReactClient } from "convex/react";
import { kortixAppBackendToken } from "@kortix/sdk";

export const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
convex.setAuth(kortixAppBackendToken("main"));   // the backend's name
```

List the backend on the App, or the App gets no token for it:

```sh
kortix apps set <app> --backends main        # or backends: [main] in kortix.yaml apps.<app>
```

`kortixAppBackendToken` fetches `GET /_kortix/backend-token?backend=main` on
the App's own origin, caches the token and refreshes it before it expires. It
yields `null` (anonymous) for every non-200 answer: to see why, call the
route yourself (Troubleshoot sign-in, below). It costs under 1 kB in the App
bundle.

Show who is signed in with a query, so the UI and the backend agree:

```ts
// convex/members.ts
import { query } from "./_generated/server";
import { requireMember } from "./lib/auth";
export const me = query({ args: {}, handler: async (ctx) => await requireMember(ctx) });
```

A static App without a backend can ask the gate directly:
`fetchKortixAppViewer()` returns the same member (name, picture, groups,
role) from `/_kortix/viewer`.

## Any other server

A server that receives the token itself (an App's own API, a Worker) verifies
it with the same SDK. With no options it reads `KORTIX_AUTH_JWKS`,
`KORTIX_AUTH_ISSUER` and `KORTIX_AUTH_AUDIENCE`, and checks the issuer and the
audience:

```ts
import { verifyKortixMemberToken, requireKortixMember, KortixMemberError } from "@kortix/sdk";

const member = await verifyKortixMemberToken(bearerToken);   // throws KortixMemberError
requireKortixMember(member, { groups: ["Finance"] });
```

To fetch the key set instead of copying it, set
`KORTIX_AUTH_JWKS=<KORTIX_AUTH_ISSUER>/jwks.json`. The SDK fetches it once per
process. `kortix backends connect <name>` prints these values.

## Who gets a token

| Caller | How | Notes |
| --- | --- | --- |
| A person using a Kortix App | `kortixAppBackendToken("<name>")` (wraps `GET /_kortix/backend-token?backend=<name>` on the App's own origin) | Needs a signed-in viewer and `--viewer` not `off`. A `public` App has one only when the person opened it through Kortix or an access link, and Kortix re-checks their access on every token. An anonymous visitor and a `password` App get `401`. |
| You (an agent) or a script | `kortix backends token <name>` · `POST /v1/projects/{projectId}/backends/{backendId}/token` · SDK `kortix.project(id).backends.token(backendId)` | A person's own credential: names that person, with groups and role. An agent session: names the agent (`sub` = its service account id, `kind: "agent"`), with no groups and no role, so `groups` or `roles` rules refuse it. |
| Admin tooling | `npx convex run --identity '{"subject":"…","issuer":"<KORTIX_AUTH_ISSUER>","groups":["Finance"]}' fn args` | Admin key only; for testing auth rules. |

An agent session never gets a token that names the person who launched it.
Calling an App's `/_kortix/backend-token` with its own Kortix token
(`$KORTIX_TOKEN`) answers `403 agent_viewer`; `kortix backends token` answers
a token that names the agent. A browser opened on
a `kortix apps access-link` URL carries that link's sign-in cookie, so the App
gets a token for the user the link was minted for. That is how you test the
App as a member (kortix-internal-apps).

Any viewer an App admits gets a token for any running backend of the App's
project, by name. Kortix does not bind an App to its backends. The token
proves who the member is, not what they may do: `requireMember` with no
`groups` or `roles` admits every viewer of every App in the project, including
the account members and groups a `restricted` App lists who are not project
members. Put `groups` or `roles` on every function whose data is not meant for
all of them.

## Groups

Kortix groups belong to an account and need the Enterprise plan. Without it,
the `groups` claim is empty and `{ groups: [...] }` refuses everyone. Use
`roles` (`owner`, `admin`, `member`) or your own roles table keyed on
`userId` instead.

## Troubleshoot sign-in

Call the route the App calls, from the App's origin, and read the code:

| Answer from `/_kortix/backend-token` | Cause | Fix |
| --- | --- | --- |
| `401 no_viewer_identity` | No Kortix session on the request, a `password` App, or a `public` App whose viewer lost access | Open the App through Kortix or an access link; set access `private`, `project` or `restricted`. |
| `403 feature_disabled` | The project has Backends off | Ask Kortix to enable Backends for the project. |
| `403 agent_viewer` | An agent session's own token | `kortix backends token <name>`. |
| `403 backend_not_listed` | The App does not list this backend (a new App lists none) | `kortix apps set <app> --backends <name>`, or `backends: [<name>]` in the App's `kortix.yaml` block. |
| `404 viewer_disabled` | The App's viewer is `off` | `kortix apps access <app> --viewer identity`. |
| `404 backend_not_found` | No running backend with that name in the App's project | Check `kortix backends list` and the name in `kortixAppBackendToken("<name>")`. |
| `409 backend_auth_unavailable` | The backend predates Kortix sign-in | Create a new backend and redeploy to it. |
| `200`, but `getUserIdentity()` is `null` | `convex/auth.config.ts` is not deployed, or its env names are wrong | Deploy `auth.config.ts` as above; `npx convex env list --names-only` must list the three `KORTIX_AUTH_*` names. |
| `200`, but `requireMember` throws `unauthenticated` | The identity's issuer is not `KORTIX_AUTH_ISSUER` | A token from another provider, or an `--identity` without `"issuer"`. |

## People who are not Kortix members

Kortix sign-in stays the sign-in for the project's own people. When an App
also serves customers or the public, add **Convex Auth** (password, magic
link, OTP or OAuth) as a second provider in the same backend. Members keep
Kortix sign-in; customers get their own accounts in the backend; the issuer
tells them apart. Convex's CLI does not set Convex Auth up on a self-hosted
backend, so follow these manual steps (from labs.convex.dev/auth/setup/manual).

1. Install, in the backend directory:

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
     return userId;   // an Id<"users"> in this backend
   }
   ```

6. The customer UI is its own App with access `public`, wrapped in
   `ConvexAuthProvider` from `@convex-dev/auth/react` (Convex's `convex-auth`
   skill). Do not call `kortixAppBackendToken` there. Keep the staff UI a
   separate App with Kortix sign-in.

A customer token never passes `requireMember`, and a member token never
passes `requireCustomer`. Test both directions before you ship.

## Test it

```sh
eval "$(kortix backends env main)" && cd backends/main
ISS=$(npx convex env get KORTIX_AUTH_ISSUER)
npx convex run tasks:list '{}'      # admin, no identity → your function must reject
npx convex run --identity "{\"subject\":\"u1\",\"issuer\":\"$ISS\",\"email\":\"a@example.com\",\"name\":\"A\",\"groups\":[\"Finance\"]}" tasks:create '{"title":"x"}'
kortix backends token main          # a real token; in a session it names the agent (no groups, no role)
```

`--identity` without `"issuer"` uses `https://convex.test`, which
`requireMember` refuses. A function that returns data for an anonymous call is
a bug. Fix it before you ship.
