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

## External object store (AWS S3 / R2)

The bundled `capture-store` grows unbounded on the box disk and shares the DB's
disk. A box already on a cloud should point Capture at that cloud's S3 instead.
The API already speaks any S3 + STS; the self-host switch is one durable `.env`
key.

`KORTIX_CAPTURE_STORE=bundled` (default) runs the on-box MinIO. `external` drops
the `capture-store` container and the `@capture` Caddy route, and the device
uploads go straight to the external store — nothing transits the box.

Set it on the box, then recreate the stack:

```
kortix self-host env set \
  KORTIX_CAPTURE_STORE=external \
  KORTIX_CAPTURE_S3_BUCKET=<bucket> \
  KORTIX_CAPTURE_S3_REGION=<region> \
  KORTIX_CAPTURE_STS_ROLE_ARN=arn:aws:iam::<account>:role/<device-role>
kortix self-host start   # reconciles the removed capture-store container
```

`.env` keys (all read by `kortix-api`; `.env` survives `kortix self-host
update`):

| Key | AWS | R2 / MinIO / path-style |
|---|---|---|
| `KORTIX_CAPTURE_S3_BUCKET` | required | required |
| `KORTIX_CAPTURE_S3_REGION` | required (e.g. `us-east-1`) | `auto` for R2 |
| `KORTIX_CAPTURE_STS_ROLE_ARN` | required | required (the API sends the session policy; a non-AWS STS treats the ARN as a label) |
| `KORTIX_CAPTURE_S3_ENDPOINT` | empty (regional endpoint) | the provider S3 endpoint |
| `KORTIX_CAPTURE_STS_ENDPOINT` | empty | the provider STS endpoint |
| `KORTIX_CAPTURE_S3_PUBLIC_ENDPOINT` | empty (devices sign the regional endpoint) | the provider public endpoint |
| `KORTIX_CAPTURE_S3_FORCE_PATH_STYLE` | `false` | `true` |
| `KORTIX_CAPTURE_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | omit (box instance role) | the provider key pair |

The box never creates the bucket in external mode
(`KORTIX_CAPTURE_S3_CREATE_BUCKET=false` is pinned); the operator or Terraform
owns it. The bundled MinIO root pair
(`CAPTURE_STORE_ROOT_USER`/`CAPTURE_STORE_ROOT_PASSWORD`) is dropped from `.env`.

IAM (AWS):

- One S3 bucket for Capture.
- A device role (`KORTIX_CAPTURE_STS_ROLE_ARN`) with S3 read/write on that
  bucket. The API calls `AssumeRole` on it and attaches a per-device session
  policy, so each device reaches only its own folder.
- The box identity (the EC2 instance role, or the configured key pair) granted
  `sts:AssumeRole` on the device role and S3 on the bucket. On AWS omit the key
  pair to use the instance role's default credential chain.

Set an S3 lifecycle rule (Intelligent-Tiering, or transition to a colder class)
on the bucket for cheap long retention — the data grows with every enrolled
device.

If `KORTIX_CAPTURE_STS_ROLE_ARN` or the bucket is missing, the API cannot issue
credentials and a device gets `503 capture_credentials_unavailable`, the same
signal as a store that is not configured.

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
