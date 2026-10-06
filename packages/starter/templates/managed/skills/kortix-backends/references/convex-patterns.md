# Convex patterns for Kortix backends

Short, correct patterns. `convex/_generated/ai/guidelines.md` (from
`npx convex ai-files install`) is the full rulebook; read it first.

## Schema

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  projects: defineTable({
    name: v.string(),
    createdBy: v.string(),               // Kortix user id (identity.subject)
    archived: v.optional(v.boolean()),
  }).index("by_archived", ["archived"]),

  tasks: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    status: v.union(v.literal("todo"), v.literal("doing"), v.literal("done")),
    assignee: v.optional(v.string()),
    dueDate: v.optional(v.number()),     // ms since epoch
    position: v.number(),
    attachment: v.optional(v.id("_storage")),
  })
    .index("by_project_status", ["projectId", "status", "position"])
    .searchIndex("search_title", { searchField: "title", filterFields: ["projectId"] }),
});
```

- Give every table a validator. Add an index for every field you filter or sort
  by; a query without an index scans the table.
- Use `v.union(v.literal(…))` for enums, `v.id("table")` for references, ms
  numbers for dates.

## Changing the schema without breaking deploys

A deploy checks every existing document against the new schema and **fails if
any document does not match**. Data is never changed by a deploy.

- **Add a field:** add it as `v.optional(...)`. Deploy. Backfill if needed
  (below). Make it required only after every document has it.
- **Rename or reshape a field:** add the new field optional, backfill, switch
  the code, then remove the old field.
- **Backfill:** write an `internalMutation` that pages through the table and
  patches documents, and run it with `npx convex run`:

```ts
// convex/migrations.ts
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

export const backfillArchived = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("projects").paginate({ cursor: cursor ?? null, numItems: 200 });
    for (const p of page.page) if (p.archived === undefined) await ctx.db.patch(p._id, { archived: false });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.migrations.backfillArchived, { cursor: page.continueCursor });
  },
});
```

For bigger migrations read the `convex-migrate` skill (Convex agent skills).
Never delete data to make a deploy pass unless the user agreed the data is
disposable (seed data is).

## Queries and mutations

```ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireMember } from "./lib/auth";

export const byProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    await requireMember(ctx);
    return await ctx.db
      .query("tasks")
      .withIndex("by_project_status", (q) => q.eq("projectId", projectId))
      .take(500);
  },
});

export const move = mutation({
  args: { taskId: v.id("tasks"), status: v.union(v.literal("todo"), v.literal("doing"), v.literal("done")), position: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireMember(ctx);
    await ctx.db.patch(args.taskId, { status: args.status, position: args.position });
    return null;
  },
});
```

- Every query is live: a React `useQuery` re-renders when its data changes. No
  polling, no websockets to manage.
- A mutation is one transaction: all writes land or none do.
- Queries and mutations cannot call `fetch`. Use an action.
- Prefer `.take(n)` or `.paginate()` over `.collect()` on tables that grow.
- Private helpers: `internalQuery` / `internalMutation` / `internalAction`,
  called as `internal.<file>.<name>`.

## Actions (external APIs)

```ts
"use node"; // only when you need Node APIs or npm packages that need Node
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

export const enrich = action({
  args: { companyId: v.id("companies") },
  handler: async (ctx, { companyId }) => {
    const company = await ctx.runQuery(internal.companies.get, { companyId });
    const res = await fetch(`${process.env.ENRICH_API_BASE}/lookup?domain=${company.domain}`, {
      headers: { authorization: `Bearer ${process.env.ENRICH_API_KEY}` },
    });
    await ctx.runMutation(internal.companies.saveEnrichment, { companyId, data: await res.json() });
  },
});
```

Set the variables with `npx convex env set NAME value` (after
`eval "$(kortix backends env main)"`). Record the names, never the values, in
the backend's README.

## HTTP actions (webhooks, public APIs)

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();
http.route({
  path: "/webhooks/stripe",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    // verify the signature before trusting the body
    await ctx.runMutation(internal.billing.ingest, { payload: await req.json() });
    return new Response(null, { status: 200 });
  }),
});
export default http;
```

The route answers on the backend's `site_url` (`kortix backends get <name>`).
It is public: authenticate inside the handler.

## Scheduling

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.daily("overdue reminders", { hourUTC: 7, minuteUTC: 0 }, internal.reminders.sendOverdue, {});
export default crons;
```

One-off: `await ctx.scheduler.runAfter(60_000, internal.x.y, args)` from a
mutation or action. Make scheduled functions idempotent.

## File storage

```ts
export const uploadUrl = mutation({ args: {}, handler: async (ctx) => { await requireMember(ctx); return await ctx.storage.generateUploadUrl(); } });
export const attach = mutation({
  args: { taskId: v.id("tasks"), storageId: v.id("_storage") },
  handler: async (ctx, a) => { await requireMember(ctx); await ctx.db.patch(a.taskId, { attachment: a.storageId }); },
});
export const fileUrl = query({ args: { storageId: v.id("_storage") }, handler: async (ctx, a) => ctx.storage.getUrl(a.storageId) });
```

Client: call `uploadUrl`, `POST` the file body to it, read `{ storageId }` from
the JSON answer, then call `attach`.

## Search

```ts
export const search = query({
  args: { projectId: v.id("projects"), text: v.string() },
  handler: async (ctx, { projectId, text }) => {
    await requireMember(ctx);
    return await ctx.db
      .query("tasks")
      .withSearchIndex("search_title", (q) => q.search("title", text).eq("projectId", projectId))
      .take(20);
  },
});
```

Vector search: `.vectorIndex(...)` in the schema and `ctx.vectorSearch` in an
action (see https://docs.convex.dev/search/vector-search).

## Seed data

Write an `internalMutation` `seed:run` that inserts demo rows only when the
tables are empty, and run it once with `npx convex run seed:run`. Never seed
from a public function.
