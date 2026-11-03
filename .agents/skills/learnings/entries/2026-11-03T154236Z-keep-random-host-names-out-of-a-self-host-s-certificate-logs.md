---
recorded: 2026-11-03T15:42:36Z
incident_date: 2026-11-02
---
# Keep random host names out of a self-host's certificate logs: give Apps and previews one wildcard certificate

**Rule:** A self-host on a public domain gives its Apps and preview hosts one wildcard certificate per base (`kortix self-host tls wildcard`), never one certificate per host. Every certificate lists its host name in the public Certificate Transparency logs, and preview labels are random by design (`dev-p3000-<sandbox>.p.<domain>`). A domain must not share a parent with unrelated instances, and no DNS record may point at an address the instance does not own.

**Trigger surface:** A user reports `ERR_SSL_PROTOCOL_ERROR` or a "certificate" error on a self-host that works from other networks. Adding a host family that gets its own certificate. Choosing the domain for a new self-host. Changing `renderCaddyfile`, the Caddy image, or `env set` / `domain move` restarts.

**Incident:** 2026-10-30 to 2026-11-03, a customer self-host on a shared Kortix parent domain.
- Home-router security filters (CUJO AI: Spectrum Security Shield, Xfinity Advanced Security) blocked the whole parent domain by TLS SNI and answered with 256 bytes of `0xFF`, which browsers show as `ERR_SSL_PROTOCOL_ERROR`. Residential-proxy probes: 6 of 8 Charter homes and 3 of 5 Comcast homes blocked; mobile carriers clean.
- The parent domain carried a retired VPS proxy route, a dead apex record and 123 per-host certificates in the CT logs, 69 of them random preview labels. Reclassification requests went to both filter vendors.
- The fix moved the instance to the customer's own domain (alias first, then `domain move`). The move recreated every app replica at once (~30 s down), and Kong kept the recreated auth container's old address: every `/auth/v1` call answered `502` for ~4 min, until Kong restarted.

**Enforcement:**
- `kortix self-host tls wildcard` (kortix-ai/suna#11595): acme-dns on the box answers DNS-01 for one delegated zone, so the operator adds NS, A and one CNAME per base once and gives Kortix no DNS token. `doctor` fails `wildcard-tls` while a base still gets per-host certificates. `apps/cli/src/self-host/__tests__/wildcard-tls.test.ts` covers the rendering, the records and the delegation check.
- `env set` and `domain move` roll the app tier start-first (`updater.sh roll`) and reload Caddy when only the Caddyfile changed; `self-host-cli.test.ts` asserts the roll and the reload.
- `KONG_DNS_VALID_TTL=5` in the rendered Compose file: Kong re-resolves a recreated upstream within 5 s.
- Docs: "Certificates and security filters" in the self-host guide.
