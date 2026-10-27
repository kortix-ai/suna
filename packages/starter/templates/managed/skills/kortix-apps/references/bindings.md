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
kortix apps link crm --uses backend     # crm may reach backend
kortix apps show crm --json             # app.uses: ["backend"]; backend shows app.used_by: ["crm"]
kortix apps unlink crm --uses backend   # remove the link
```

`--uses <slugs>` on `kortix apps create` sets the list at create, and on
`kortix apps set` replaces it (`--uses=` clears it).

In `kortix.yaml`, `uses` in the App's block is the source of truth: a push
applies it on sync, and `kortix apps link` / `set --uses` write it there first:

```yaml
apps:
  backend:               # the Convex template (convex.md), abridged: launch writes the full block
    type: oci_image
    image: ghcr.io/convex/convex-backend@sha256:…
    command: ["sh", "-c", "cd /convex && exec ./run_backend.sh"]
    http_service: { internal_port: 3210, access: public }
  crm:
    path: apps/crm/dist
    type: static
    spa: true
    uses: [backend]
```

`kortix apps deploy` with no arguments deploys every block that has a `path`
or `image`, used Apps first; a block with neither is skipped.
A slug that names no App of the project answers `400 app_not_found`.

## Use a binding in code

```ts
import { ConvexReactClient } from "convex/react";
import { kortixBinding } from "@kortix/sdk";

const backend = kortixBinding("backend");
// backend.url   = location.origin + "/_kortix/apps/backend"
// backend.token = a fetcher for a 15-minute token whose audience is backend
export const convex = new ConvexReactClient(backend.url);
convex.setAuth(backend.token);
```

To read the signed-in member in React, use a `members:me` query
(`useQuery(api.members.me)`), not `useConvexAuth()`. See sign-in.md, "The
browser: send the token".

The request passes the using App's own access gate first, so only people the
App admits reach the bound App through it. They need no access to the bound
App itself. The bound App still checks every call itself (`requireMember`,
sign-in.md): its own URL is public.

| Answer on `/_kortix/apps/<slug>/…` | Cause | Fix |
| --- | --- | --- |
| `403 app_not_linked` | The App does not use `<slug>` | `kortix apps link <app> --uses <slug>` |
| `409 app_binding_unsupported` | The used App is static: it runs no server | Fetch a static App's files on its own URL. |
| `403 app_binding_forbidden` | The service is `access: admins` | An admins-only service is never bound. |
| `404 app_service_not_found` | `<slug>--<service>` names no service | Check `kortix apps show <slug> --json` → `services`. |
| `503 app_binding_unavailable` | The used App has no running release | Deploy it, or start it. |
| `401 app_auth_required` | The viewer did not pass the App's access gate | Open the App through Kortix or an access link. |

## What stays on the used App's own host

The binding is for App code in the browser. `/_kortix/apps/<slug>/*` reaches
the used App's `http` service and `/_kortix/apps/<slug>--<service>/*` another of
its services; a service with `access: admins` is never bound
(`403 app_binding_forbidden`). These keep the used App's own URLs
(`app.services[].url`):

- The Convex CLI (`npx convex …` with `CONVEX_SELF_HOSTED_URL` = the App URL).
- File storage URLs that Convex makes (`ctx.storage.getUrl`): they name the
  App's own host.
- HTTP actions (`convex/http.ts`): they answer on the `site` service's URL.
- Scripts, servers and other clients outside an App (sign-in.md, "Who gets a
  token").

**A server App that calls an App it uses** (an API in front of a backend): the
binding is browser-only (it needs the viewer's App cookie, which the gate keeps).
Call the used App on its own URL instead. Every machine gets
`KORTIX_USES_URL_<SLUG>` (`-` → `_`) for each App its App uses: a `crm-data`
backend is at `process.env.KORTIX_USES_URL_CRM_DATA`. The browser mints a token
for the used App (`kortixToken('crm-data')`) and sends it to your server; the
server forwards it as `Authorization: Bearer`. The backend verifies it as usual
(sign-in.md). Never hard-code a host: a relaunch can change it. A new `uses`
link reaches the machines with the next deploy.
