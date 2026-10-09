# Apps that use other Apps

An App can **use** other Apps of the same project. The link does two things:

1. **Sign-in tokens.** Code in the App gets a token for an App it uses
   (`/_kortix/token?audience=<slug>`, sign-in.md). For any other App it gets
   `403 app_not_linked`.
2. **The bindings mount.** `/_kortix/apps/<slug>/*` on the App's own origin
   reaches the used App's endpoint, HTTP and WebSocket, with the prefix
   removed. App code needs one origin, no CORS and no build-time URL.

A new App uses none.

## Set the links

```sh
kortix apps link crm --uses db          # crm may reach db
kortix apps show crm --json             # app.uses: ["db"]; db shows app.used_by: ["crm"]
```

In `kortix.yaml`, `uses` in the App's block replaces its list on every
`kortix apps deploy`:

```yaml
apps:
  db:
    path: apps/db
    kind: convex
  crm:
    path: apps/crm/dist
    type: static
    spa: true
    uses: [db]
```

`kortix apps deploy` with no arguments deploys every block, used Apps first.
A slug that names no App of the project answers `400 app_not_found`.

## Use a binding in code

```ts
import { ConvexReactClient } from "convex/react";
import { kortixBinding } from "@kortix/sdk";

const db = kortixBinding("db");
// db.url   = location.origin + "/_kortix/apps/db"
// db.token = a fetcher for a 15-minute token whose audience is db
export const convex = new ConvexReactClient(db.url);
convex.setAuth(db.token);
```

The request passes the using App's own access gate first, so only people the
App admits reach the bound App through it. The bound App still checks every
call itself (`requireMember`, sign-in.md): its own URL is public.

| Answer on `/_kortix/apps/<slug>/…` | Cause | Fix |
| --- | --- | --- |
| `403 app_not_linked` | The App does not use `<slug>` | `kortix apps link <app> --uses <slug>` |
| `409 app_binding_unsupported` | The used App has no endpoint to bind | Only a `convex` App has one (its Convex client API). Call a web App on its own URL. |
| `401 app_auth_required` | The viewer did not pass the App's access gate | Open the App through Kortix or an access link. |

## What stays on the used App's own host

The binding is for App code in the browser. These keep the `convex` App's own
`instance.url` and `instance.site_url`:

- The Convex CLI (`npx convex …`, after `eval "$(kortix apps credentials <slug>)"`).
- File storage URLs that Convex makes (`ctx.storage.getUrl`): they name the
  App's own host.
- HTTP actions (`convex/http.ts`): they answer on `instance.site_url`.
- Scripts, servers and other clients outside an App (sign-in.md, "Who gets a
  token").
