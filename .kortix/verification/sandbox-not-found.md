# Sandbox not found investigation

## Origin of the error

- Exact `{"error":"Sandbox not found"}` is returned by the sandbox preview proxy in `apps/api/src/sandbox-proxy/index.ts:169-171`.
- That handler serves preview requests on `GET/POST/etc /v1/p/:sandboxId/:port/*` when the API is running in **JustAVPS-only** mode.
- In that mode it calls `resolveProvider(sandboxId)`, which looks up `sandboxes.externalId = :sandboxId` in the DB. If no row is found, it returns `404 {"error":"Sandbox not found"}`.

## Request path / trigger condition

- Frontend sandbox URLs are built as `{BACKEND_URL}/p/{sandboxId}/{containerPort}` in `apps/web/src/lib/platform-client.ts:45-51` and `apps/web/src/stores/server-store.ts:144-155`.
- For local dev, the expected path is typically `/v1/p/local/8000/...` or `/v1/p/<local-container-name>/8000/...`.
- The 404 happens when the backend is configured for `justavps`, because it treats that path as a cloud-sandbox lookup instead of direct local Docker proxying.

## Env/config comparison

Compared sibling repo envs:

- `computer/apps/api/.env` had a copied cloud-style sandbox block.
- `comp/apps/api/.env` also had cloud values:
  - `ALLOWED_SANDBOX_PROVIDERS=justavps`
  - `KORTIX_URL=https://dev-new-api.kortix.com/v1/router`
- But `comp/apps/api/.env.example` documents the local default as:
  - `ALLOWED_SANDBOX_PROVIDERS=local_docker`
- `core/docker/.env` still identifies the local sandbox as `SANDBOX_ID=local`, which matches the local-preview flow, not the JustAVPS DB-resolved flow.

## Most likely root cause

Recent env copying left `apps/api/.env` in a **cloud/JustAVPS configuration** while the user is running a **local Docker stack**.

That puts the preview proxy onto the wrong code path:

1. browser requests `/v1/p/<local sandbox id>/8000/...`
2. API runs JustAVPS-only proxy logic
3. API looks for a JustAVPS sandbox row by `externalId`
4. no matching DB row exists for the local sandbox id
5. API returns `{"error":"Sandbox not found"}`

## Applied fix

I updated `/Users/vukasinkubet/dev/comp/apps/api/.env` to restore local-dev sandbox routing:

- removed the copied `KORTIX_URL=...` override
- changed `ALLOWED_SANDBOX_PROVIDERS=justavps` → `ALLOWED_SANDBOX_PROVIDERS=local_docker`

## Exact next steps

1. Restart the API/container stack so `apps/api/.env` is reloaded.
2. Re-open a sandbox-backed page or hit a preview URL again.
3. If any stale localStorage server entry still points at an old cloud sandbox, switch servers or reload after the API restart.

## Confidence

High. The error string, request path, and env mismatch line up directly with the proxy branching logic.
