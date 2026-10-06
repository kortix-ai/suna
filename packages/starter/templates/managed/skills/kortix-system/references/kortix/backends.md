# Kortix Backends

A Kortix backend is a full backend for the project: a database, server
functions, realtime queries, file storage, and schedules, powered by Convex.
Each backend is a self-hosted Convex instance in its own always-on machine. The
Convex code lives in the project repo. You edit it on the session branch and
deploy it with one command.

Backends is experimental and off by default. Enable **Backends** under Project
Settings → Feature flags. It exists only where Platinum is configured. While it
is off, every `kortix backends` command prints that Backends is not enabled and
exits `1`.

## When to use a backend

Use a backend when an App or an agent needs:

- data that outlives a session, with typed queries;
- realtime updates in a UI (a query re-runs when its data changes);
- server functions that hold secrets or enforce rules;
- uploaded files, scheduled jobs, or full-text search.

Do not use a backend for static content or for files that belong in the repo.
Use project secrets for credentials. Use an App for the web UI. The backend is
the data and logic behind the App.

## Repo layout

```text
backends/main/
  package.json        # depends on "convex"
  convex/
    schema.ts
    messages.ts       # queries and mutations
    http.ts           # HTTP actions (optional)
    crons.ts          # schedules (optional)
```

One directory per backend. The directory name matches the backend name. A
project holds up to 3 backends.

Minimal `package.json`:

```json
{
  "name": "main-backend",
  "private": true,
  "dependencies": { "convex": "^1" }
}
```

Run `npm install` in `backends/main/` once.

## The deploy loop

```sh
kortix backends deploy main --dir backends/main
```

The command creates the backend `main` if it is missing, waits until it is
`running`, then runs `npx convex deploy` in `backends/main` with the backend's
credentials. A create takes a few seconds. The first create in a region takes
longer, because it builds the machine image.

Loop: edit `convex/`, run the deploy, read the output, fix, repeat. Commit the
Convex code on the session branch like any other code. Deploy again after a
merge only when the code changed.

Other commands:

| Command | Use |
| --- | --- |
| `kortix backends list` | List backends and their status. |
| `kortix backends create <name>` | Create without deploying. |
| `kortix backends get <name>` | Show `url`, `site_url`, and status. |
| `kortix backends env <name>` | Print the Convex CLI variables. |
| `kortix backends delete <name>` | Delete the machine and all data. Cannot be undone. |

Status values: `provisioning`, `running`, `error`. On `error`, delete the
backend and create it again.

## Schema

Define every table with validators in `convex/schema.ts`:

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    channel: v.string(),
    author: v.string(),
    body: v.string(),
    attachment: v.optional(v.id("_storage")),
  })
    .index("by_channel", ["channel"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
});
```

Add an index for every field you filter by. A query without an index scans the
table.

## Queries and mutations

Use the object syntax with `args` and `returns` validators:

```ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { channel: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("messages"),
      _creationTime: v.number(),
      channel: v.string(),
      author: v.string(),
      body: v.string(),
      attachment: v.optional(v.id("_storage")),
    }),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", args.channel))
      .order("desc")
      .take(50);
  },
});

export const send = mutation({
  args: { channel: v.string(), author: v.string(), body: v.string() },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", args);
  },
});
```

Rules:

- Call a function from the client as `api.<file>.<name>`, for example
  `api.messages.list`. Use `internal.*` for private functions
  (`internalQuery`, `internalMutation`, `internalAction`).
- A query or mutation cannot call `fetch`. Use an action for that.
- Prefer `.take(n)` or `.paginate()` to `.collect()` on a table that can grow.
- A mutation is one transaction. It either writes everything or nothing.

## Actions

An action can call external APIs. It reads and writes data through queries and
mutations:

```ts
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

export const summarize = action({
  args: { channel: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const messages = await ctx.runQuery(internal.messages.recent, { channel: args.channel });
    const res = await fetch("https://api.example.com/summarize", {
      method: "POST",
      body: JSON.stringify(messages),
    });
    return await res.text();
  },
});
```

Set an environment variable the action reads with
`npx convex env set NAME value` (see "Read and write data as an agent").

## HTTP actions

An HTTP action answers a request on the backend's `site_url`:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    await ctx.runMutation(internal.messages.ingest, { payload: body });
    return new Response(null, { status: 200 });
  }),
});

export default http;
```

Find `site_url` with `kortix backends get <name>`. The route is public. Verify
a signature or token inside the handler.

## Crons

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("clean old messages", { hours: 24 }, internal.messages.cleanup, {});
export default crons;
```

A cron targets an internal function. Make the function idempotent. To run a
function once later, call `ctx.scheduler.runAfter(delayMs, internal.x.y, args)`
from a mutation or action.

## File storage

```ts
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const fileUrl = query({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => await ctx.storage.getUrl(args.storageId),
});
```

The client calls `generateUploadUrl`, `POST`s the file to that URL, reads
`storageId` from the JSON response, then saves the id on a document.

## Search

A search index (see Schema) powers full-text search:

```ts
export const search = query({
  args: { channel: v.string(), text: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("messages")
      .withSearchIndex("search_body", (q) =>
        q.search("body", args.text).eq("channel", args.channel),
      )
      .take(20),
});
```

## Wire an App to the backend

The backend URL is public, not secret. Set it as an App environment variable.
Pick the name your framework exposes to the browser: `VITE_CONVEX_URL` (Vite),
`NEXT_PUBLIC_CONVEX_URL` (Next.js), or `CONVEX_URL` (server code). Get the value
with `kortix backends get main --json`, field `url`.

```tsx
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { api } from "../backends/main/convex/_generated/api";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

export function Root() {
  return (
    <ConvexProvider client={convex}>
      <Chat />
    </ConvexProvider>
  );
}

function Chat() {
  const messages = useQuery(api.messages.list, { channel: "general" });
  const send = useMutation(api.messages.send);
  // messages is undefined while it loads, then updates in realtime.
}
```

The generated `api` file comes from `npx convex deploy`. Import it from the
backend directory, or copy it into the App if the App builds on its own.

Never put the admin key in an App, in the client bundle, or in an App
environment variable. Browser code uses the public `url` only. Enforce access
rules inside the Convex functions.

## Read and write data as an agent

Load the credentials into the shell. Never print them:

```sh
eval "$(kortix backends env main)"
```

This sets `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` for the
shell. Then use the Convex CLI from the backend directory:

```sh
cd backends/main
npx convex data                          # list tables
npx convex data messages --limit 20      # read a table
npx convex run messages:send '{"channel":"general","author":"agent","body":"hi"}'
npx convex env set OPENAI_BASE_URL https://example.com
npx convex logs                          # function logs
npx convex export --path /tmp/backup.zip # data and files
```

Do not run `npx convex dev` or `npx convex dashboard`. Use `deploy`, `run`,
`data`, `env`, `logs`, and `export`.

## Secrets rule

The admin key controls all code and data in the backend. Kortix audits every
read as `backend.credentials.read`.

- Never echo, print, or log the admin key.
- Never write it to a file, a commit, a change request, or chat.
- Never put it in `kortix.yaml`, an App, or a project secret value you
  display.
- Use `eval "$(kortix backends env <name>)"` so the key stays in the shell
  environment only.

## Limits and gotchas

- A project holds up to 3 backends. The fourth create answers `409
  backend_limit`. A repeated name answers `409 backend_name_taken`.
- A name uses lowercase letters, digits, and dashes. It starts with a letter.
- A backend is always on. Its machine is fixed at 1 vCPU, 1 GB memory, and
  10 GB disk. Backends are not metered yet.
- Data lives on the machine disk (SQLite). Kortix backs it up with the machine
  disk.
- Kortix has no dashboard for a backend yet. Use the CLI or MCP.
- Convex Auth needs manual setup. Custom JWT or OIDC authentication through
  `auth.config.ts` works.
- Convex cloud features are absent: preview deployments, the AI gateway for
  `@convex-dev/agent`, and audit logs. Call a model provider from an action
  with a key set through `npx convex env set`.
- `npx convex export` covers data and files. It does not cover environment
  variables or pending scheduled jobs. Record environment variable names in the
  repo (values stay out) so you can set them again.
- `kortix backends delete` removes the machine and all data. Export first when
  the data matters.
- A backend in `provisioning` has no credentials yet. `kortix backends env`
  answers `409 backend_not_running` until it is `running`.
