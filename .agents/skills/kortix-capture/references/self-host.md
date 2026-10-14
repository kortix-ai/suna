# Kortix Capture on a self-hosted deployment

Load this for any question about Capture sync on `kortix self-host`: why a
device gets 503, how the store is wired, how to upgrade, how to prove it.

## Problem

Devices upload straight to an S3-compatible store with short-lived credentials
from `POST /v1/capture/credentials` (`apps/api/src/capture/credentials.ts`).
The issuer uses STS AssumeRole with a session policy. The self-host stack had
no STS, so every device got `503 capture_credentials_unavailable`.

## Decision

The self-host Compose project runs `capture-store`: MinIO, pinned by digest,
data in the volume `kortix-capture-data`, no published port.

Constraint: zero extra DNS records, ports 80 and 443 only, and `--tunnel
cloudflare` must work. SigV4 signs the host and path, so the device must reach
the store at the exact host and path it signs. MinIO has no base path. Path-style
S3 puts the bucket first (`/kortix-capture/<key>`), and no API route uses that
prefix. So the store is served on the API origin under that prefix, with the
Host header and path untouched.

| Mode | What serves `https://api.<domain>/kortix-capture/*` |
|---|---|
| domain | Caddy, `@capture` in `apps/cli/src/self-host/assets/Caddyfile.txt`. Uploads do not depend on the API. |
| tunnel, local | The API, `apps/api/src/capture/store-proxy.ts`, when `KORTIX_CAPTURE_S3_PROXY_TARGET` is set. A named tunnel has an operator-set origin, so only the API can serve the prefix there. |

Rejected:

- A MinIO host such as `s3.<domain>`: an extra DNS record and certificate.
- Supabase Storage S3: it has no STS. Scoping would need a custom JWT plus RLS
  policies on `storage.objects`. More moving parts than a store that enforces
  the session policy natively.
- API as the S3 endpoint for every mode: uploads fail during every API
  roll-out, and every byte passes through the API.

## Wiring

- `apps/cli/src/self-host/assets/kortix-compose.yml`: the `capture-store`
  service, the `KORTIX_CAPTURE_*` environment of `kortix-api`. `PUBLIC_ENDPOINT`
  is `${KORTIX_URL}`: the origin sandboxes call the API on (tunnel mode
  rewrites it after the tunnel starts).
- `compose-assets.ts`: removes `PROXY_TARGET` in domain mode.
- `defaultEnv()` generates `CAPTURE_STORE_ROOT_USER` and
  `CAPTURE_STORE_ROOT_PASSWORD`. An existing `.env` gets them on the next
  `init`, `start` or `update`.
- The API creates the bucket: `ensureCaptureBucket()` in
  `apps/api/src/capture/store.ts`, run by the leader worker while
  `KORTIX_CAPTURE_S3_CREATE_BUCKET` is on.
- No bucket events without SQS: the index reader polls every 30 s
  (`KORTIX_CAPTURE_INDEX_POLL_SECONDS`).

## Upgrade an existing install

The nightly updater never re-renders Compose. On the box:
`kortix self-host update` with a CLI that knows the store. It generates the
secrets, adds `capture-store`, and recreates `kortix-api` once. The API image
must be a release with the passthrough. `kortix self-host doctor` reports
`capture-store`.

## Prove it (local, same Compose the CLI renders)

1. `kortix self-host init --yes --version <local tag> --local-images` and
   `start`. Domain mode on a laptop: `--domain localhost` gets Caddy's internal
   CA, and the device client needs `NODE_TLS_REJECT_UNAUTHORIZED=0`.
2. Sign up a user, create an account, `PUT .../capture/workspace {enabled:true}`.
3. `POST .../capture/enrollment-tokens`, then `POST /v1/capture/device/enroll`.
4. `POST /v1/capture/credentials` with the device token: 200.
5. Upload the fixture device (`vendoredDevice` in `tests/src/fixtures/capture.ts`)
   with the issued credentials. `POST .../capture/devices/:id/sync`, then
   `GET .../capture/timeline` lists the items.
6. Scoping: a PUT under another device's folder, a PUT of its own `policy.json`
   and a LIST of the account prefix answer `AccessDenied`.

## Limits

- MinIO ignores the role ARN. Only the session policy limits a device.
- The API holds the MinIO root pair, as it holds the Supabase service role key.
- One store container, one volume: no replication. Back up the volume.
