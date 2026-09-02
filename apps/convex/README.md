# kortix-convex

Convex deployment for Kortix: kitcn ORM schema, Better Auth identity (all
plugins, organizations included), and the Convex functions the Kortix API
calls through `ConvexHttpClient`. Decision record: `docs/adr/007-convex-better-auth-one.md`.

## Run locally (no Convex account)

```sh
pnpm --filter kortix-convex bootstrap:local   # anonymous local backend on 127.0.0.1:3210 / site 3211
pnpm --filter kortix-convex dev:local         # watch mode
```

Better Auth endpoints: `http://127.0.0.1:3211/api/auth/*`.
JWT for the Kortix API: `GET /api/auth/convex/token` with the session cookie.

## Schema changes

Auth tables are managed by kitcn. After any plugin or version change:

```sh
pnpm --filter kortix-convex exec kitcn add auth --schema --yes
```

Kortix domain tables go in `convex/functions/schema.ts` (`convexTable`, `index`, `.relations`).
