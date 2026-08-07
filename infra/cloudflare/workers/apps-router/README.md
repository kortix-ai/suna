# Kortix Apps router

This Worker routes one-level App hostnames to the matching Kortix API. It signs
the original host, method, path, and query with `EDGE_SECRET`. The API verifies
the signature before it reads App state or starts a sandbox.

Required Cloudflare resources:

- A proxied `*.apps.kortix.com` DNS record.
- A Worker route for `*.apps.kortix.com/*`.
- An Advanced Certificate Manager certificate containing `*.apps.kortix.com`.
- The `EDGE_SECRET` Worker secret.

The API environment must receive the same value as `KORTIX_APPS_EDGE_SECRET`.
Do not store this value in `wrangler.toml` or another tracked file.

Deploy:

```sh
npx --yes wrangler@4.34.0 secret put EDGE_SECRET
npx --yes wrangler@4.34.0 deploy
```
