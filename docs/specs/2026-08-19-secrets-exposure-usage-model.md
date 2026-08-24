# Secrets: the exposure/usage model

> **Update 2026-08-20 — egress-enforced shipped behind an experimental flag.**
> The exposure/usage split below shipped, but egress-enforced delivery (network
> substitution / "Enforce at the network") is gated by a per-project feature
> flag `secrets_egress` (Settings → Feature flags), **OFF by default**, while it
> is still in testing across providers. The **default exposure is `environment`**
> — the real value loads into the sandbox (`strategy: runtime`). With the flag
> off, the secret-write routes reject entering egress delivery with `403
> feature_disabled`, the picker offers only Environment variable and Disabled,
> and no capability is served as a `network` handle. So wherever this spec below
> says egress-enforced is "the default" or "the primary" mode, read it as "the
> default **once the flag is enabled**". A secret already on egress keeps
> serving and stays editable even when the flag is off.

**Status:** approved 2026-08-19, shipped 2026-08-20 with egress-enforced behind the `secrets_egress` flag
**Supersedes the user-facing model of:** `docs/SECRET_DELIVERY_CONTROL_PLANE.md` (mechanism doc — stays accurate for internals), `docs/NETWORK_BOUNDARY_WITHOUT_PLATINUM.md` (design history — stays as record)
**Decision owner:** Marko

---

## 1. Axioms

1. A secret has one value and a set of legitimate spenders. Everything else is derived.
2. The agent is untrusted (prompt injection, log leaks, `env` dumps). Minimize the places the
   real value exists without breaking the spender.
3. There are exactly two kinds of secrets, and it is a property of the UPSTREAM, not of Kortix:
   - **Sent secrets** — the value travels on the wire (API keys, bearer tokens, passwords).
     The vast majority. These can be enforced at the network boundary, because there is a
     moment where the value is bytes in a request.
   - **Computed secrets** — the value is an ingredient in a calculation and never travels
     (AWS SigV4, HMAC webhook signing, JWT client assertions, SSH keys). Whoever computes must
     hold. No boundary helps; only the environment (today) or a server-side signing service
     (explicitly out of scope) can serve them.
4. The agent must never choose a destination. Every path that spends a secret is gated on the
   same server-side host allow-list (`matchRule`).

## 2. The root defect being fixed

`strategy` + `consumer` conflates two ORTHOGONAL dimensions into one forced choice:

- **Exposure** — can agent code read the value? (`environment` / `egress-enforced` / `none`)
- **Usage** — who spends it? (agent code, LLM gateway, connector:<slug>, git)

They are independent: `ANTHROPIC_API_KEY` is spent by the LLM gateway AND legitimately by
agent code calling `api.anthropic.com` directly. The current picker is six points sampled off
that 2-D space and flattened into a list; that is the whole confusion.

## 3. The user-facing model

Each secret presents as:

```
value          (encrypted, unchanged)
exposure       environment | egress-enforced | none
hosts[]        only when egress-enforced
usages         labels, mostly system-assigned: agent code (implied by exposure != none),
               LLM gateway, Connector:<slug>, Git
```

- **environment** — real value in the sandbox env. Required for computed secrets and
  non-HTTPS protocols. Warning-toned everywhere it renders.
- **egress-enforced** — the env var holds a **handle** (see §5). The value is substituted
  server-side, only on requests to the approved hosts. Default for everything sent.
- **none** — no sandbox presence. A pure LLM-gateway key or connector credential is
  `none` + a usage. "Disabled" is `none` with zero usages.

### Storage mapping — NO data migration, NO schema migration

`strategy`/`consumer` columns are unchanged. Read-side mapping:

| stored | exposure | usage label |
| --- | --- | --- |
| `runtime`/`sandbox` | environment | agent code |
| `egress`/`network` | egress-enforced | agent code |
| `broker`/`http_broker` | egress-enforced | agent code |
| `broker`/`llm_gateway` | none | LLM gateway |
| `broker`/`connector` | none | Connector:<slug> |
| `broker`/`git_proxy` | none | Git (system-managed, never editable) |
| `denied` | none | — (renders "Disabled") |

Write-side: the picker writes exactly the pairs above. New egress-enforced rows are written
as `egress`/`network` with a hosts-only policy (§6).

## 4. One mechanism, all three providers

```
agent's ordinary HTTP client
  └─▶ in-guest shim (terminates TLS for approved hosts ONLY; holds NO secret)
       └─▶ broker route POST /projects/:id/secrets/-/egress  (or existing per-secret route)
            matchRule host gate → resolve grant/session allowlist → decrypt
            → substitute handle(s) → call upstream → redact echoes (4 encodings)
            → per-request audit record → return response
```

- Identical on **daytona, e2b, platinum**. The Platinum provider-edge path stops serving
  secrets: `startNetworkBoundaryArm` no longer calls `provider.syncNetworkBoundary`; the
  `network_boundary_shim` feature flag is DELETED (registry, web `use-project-feature-flags`,
  all reads); `networkBoundaryMode` collapses to the always-shim answer or is deleted with its
  call sites rewritten. Commit `e7d9bdad0c`'s "do not arm the shim where a provider edge owns
  the destination" narrowing is reverted — nothing is edge-owned any more.
- Old daemons keep working: substitution is SERVER-side, so any shim that relays gets the new
  behavior. Old daemons on Platinum arm the shim when the API stops marking destinations
  edge-owned (that is the documented `absent → arm` default in `e7d9bdad0c`).
- Legacy stored rows with an `inject` config keep injecting exactly as today (the broker
  still applies policy injection when `inject` is present). New rows have no `inject`
  (§6) and are served purely by substitution.
- `kortix secrets call` (explicit broker door) STAYS working — same `matchRule`, same
  redaction — but is no longer a UI choice. It exists for requests the shim cannot intercept.
- Every transparent request now produces a per-request audit record — strictly better than
  the Platinum edge, which audited nothing.
- Unapproved hosts tunnel blind. Pinned TLS and mTLS untouched. A handle leaving to an
  unapproved host leaves as a worthless self-describing string.

## 5. The handle

`mintHandle` (`apps/api/src/secrets/strategy.ts`) is already built and is used as-is:
self-describing default prefix, `[A-Za-z0-9_-]`-safe, random lookup id + HMAC tag verified
statelessly before any DB work, optional vendor-shaped prefix (`sk_live_…`) for
format-validating SDKs (prefix comes from the known-key catalog; NEVER derived from the real
value).

New work: egress-enforced secrets deliver `IDENTIFIER=<handle>` into the sandbox env (today
`egress`/`network` delivers nothing). Delivered through the existing env-sync path
(`resolveSecretDelivery` / `sandbox-env-sync.ts`), rotated per session like broker handles.

### Substitution (the one genuinely new server component)

In the broker relay, for the destination host H:

1. Collect the session's spendable secrets whose policy admits H (grant ∩ session allowlist,
   same resolution as today's broker call — substitution must never widen who can spend).
2. Scan header values, URL path+query, and body for each secret's handle in FOUR
   representations: raw, URL-encoded, base64, JSON-escaped (the dual of
   `redactSecretFromResponse`, `apps/api/src/secrets/http-broker.ts` — share the encoding
   machinery, do not duplicate it).
3. Replace handle → real value; recompute `content-length`; the relay is already fully
   buffered.
4. Request bodies are forced to `identity` encoding by the shim (it already forces it on
   `accept-encoding`; assert the request-side too).
5. HMAC tag must verify before any handle is honored. A bad tag is FORGED, a valid tag for a
   secret this session may not spend is STOLEN — keep them distinguishable in audit.

## 6. Policy collapse

For egress-enforced rows the policy is a HOST LIST. Concretely:

- `SecretEgressPolicy.inject` becomes OPTIONAL in `packages/api-contract` and validation.
  Absent `inject` = substitution-only row. Present `inject` = legacy injection row (still
  valid, still served).
- `networkBoundaryPolicyError` drops the header/template/method/path prohibitions for
  inject-less rows; it still requires exact hosts, HTTPS, `on_no_match: deny`.
- `findBoundaryDestinationConflict` (the one-`(host,header)`-per-project 409) applies ONLY to
  rows that carry `inject`. Two substitution rows on one host are legal — each handle maps to
  its own value.
- Header name, value template, and the "Header value template" editor field are removed from
  the creation/edit UI. (Prerequisite #3 in the control-plane doc — the 401-from-a-bad-template
  failure — ceases to exist for new rows.)

## 7. Creation flow — the system decides, the user overrides

User supplies **name + value**. Classification:

| Recognition | Default | Prefilled |
| --- | --- | --- |
| Known model key (existing gateway catalog) | egress-enforced + LLM-gateway usage | vendor host + vendor handle prefix |
| Recognizable signing credential (`AKIA…` access-key pairs, PEM/SSH material) | environment, with one sentence: "this key signs requests locally; egress enforcement cannot apply" | — |
| Everything else | egress-enforced | hosts empty, user fills |

One visible control: **"Can your code read this value?"**
- **No — enforce it at the network** (default): hosts field appears.
- **Yes — put it in the environment**: warning tone.
Plus "Disabled". Connector and Git usages remain assigned by their own flows and render as
read-only labels (the `git_proxy` treatment generalized). LLM gateway is auto-assigned.

## 7.5. The streaming relay — a second transport, not a replacement

§4 puts an in-guest shim in front of every egress-enforced secret and relays each
request to Kortix, which holds the credential. The original transport buffers:
the shim base64s the whole request into a JSON envelope, POSTs it, and buffers
the whole response back. That is where the **1 MiB request / 5 MiB response
caps** come from, and why SSE, chunked responses and websockets were impossible.

There are now **two transports over the same policy engine**.

### 7.5.1 The two routes

| | Buffered (permanent) | Streaming |
| --- | --- | --- |
| Path | `POST …/secrets/{id}/broker` | `POST …/secrets/{id}/relay` |
| Envelope | JSON, `body_base64` | body bytes VERBATIM, `application/octet-stream` |
| Metadata | in the JSON body | `x-kortix-relay-meta` (base64url JSON) |
| Caps | 1 MiB / 5 MiB | byte budgets only (default 1 GiB, `0` = unlimited) |
| SSE / long bodies | no | yes |

`/broker` is **PERMANENT, not deprecated**. The daemon ships inside the sandbox
image and a box booted today can be resumed months from now, so its path,
schema, status codes, error codes and audit actions are frozen. Both routes run
the same authorization core (`apps/api/src/secrets/relay-authorize.ts`) and the
same head-side policy gate (`prepareRelayHead`, `apps/api/src/secrets/http-broker.ts`)
— one implementation, two callers, so the two cannot drift.

### 7.5.2 The wire contract

Request: `x-kortix-relay: 1`, `x-kortix-relay-meta: base64url(JSON)` (≤ 64 KiB),
body = the guest's bytes after the shim has undone any `content-encoding`.

The meta carries `{v, url, method, headers, body}` where `headers` is an
**ordered array of `[name, value]` pairs with duplicates preserved**. It is an
array and not an object because Bun's HTTP header parser silently collapses
duplicate headers outside its known-header table to the LAST value (measured on
bun 1.3.14), so the API cannot recover the guest's header list from the wire.

Response, on success:

```
HTTP/1.1 200 OK
x-kortix-relay-status: base64url({"v":1,"status":429,"headers":[["retry-after","5"]]})
<redacted upstream body, streamed>
```

**The disambiguator, and it is the load-bearing rule:** `x-kortix-relay-status`
PRESENT ⟺ Kortix reached the upstream and that payload's `status` is the
upstream's. ABSENT ⟺ Kortix itself refused, and the relay's own status plus
`x-kortix-relay-error` say why. The relay's own status is therefore **always
200 on success**, whatever the upstream said — mirroring it would make a bare
`403` ambiguous between "policy denied" and "Stripe said 403", a distinction the
buffered envelope preserves and the agent acts on.

A failure AFTER the 200 is committed terminates the chunked response without its
final `0\r\n\r\n`. Chunked framing is self-terminating, so the missing
terminator IS the error signal. No HTTP trailers are used.

### 7.5.3 Framing, in decision order

The guest's own `content-length` / `transfer-encoding` never travel — both are
in `BLOCKED_REQUEST_HEADERS`.

1. **No body** → no body, no length header.
2. **Nothing substitutable here** (`isPassThrough`) **and a known length** →
   forward that exact `content-length` and stream the bytes untouched. The
   length is provably unchanged. `openUpstream` emits EXACTLY ONE framing
   header: a caller-set `content-length` on a stream suppresses
   `transfer-encoding: chunked`, and the declared count is enforced in the write
   loop (`413 relay_request_too_large` on an overrun, `400` on a short body).
   Setting both is a request-smuggling primitive under Node, and under bun
   1.3.14 it silently drops the `Content-Length` — measured — which made this
   promise inert and sent every pass-through body chunked.
3. **Known length ≤ 64 KiB** (`RELAY_EXACT_LENGTH_MAX`) → buffer it, substitute
   with the same whole-buffer routine `/broker` uses, and set the exact
   post-substitution `content-length`. Byte-for-byte identical to today for the
   ordinary small JSON POST, replayable across a redirect, and the full body is
   available to the handle-refusal classifier.

   The read is **bounded by the read itself**, not by the declaration:
   `meta.body.length` is an assertion by the caller and is never a size
   guarantee. Byte `declared + 1` ends the request with
   `413 relay_request_too_large` before the upstream is opened. There is no
   ambient ceiling to fall back on — `Bun.serve` applies no `maxRequestBodySize`
   to a chunked body, and this route is exempt from both the 25 s request
   deadline and Bun's per-request timeout — so an unbounded read here is a
   one-request OOM of a shared multi-tenant pod.
4. **Otherwise** → `transfer-encoding: chunked`, streamed through
   `StreamSubstituter`.

Case 4 is the one chunked-hostile exposure (a SigV4-style signer with a handle
in a >64 KiB body); it surfaces as the upstream's own `411`, relayed honestly.
Do not pre-scan to compute a length — that reintroduces the cap.

### 7.5.4 Substitution and redaction stream

`apps/api/src/secrets/stream-substitute.ts` is the kernel: a chunk-boundary-safe
find/replace whose memory is bounded by `longestNeedle - 1`, not by the body.
Its retention is **prefix-aware** — it holds back only bytes that are a proper
prefix of some needle. A blind `longestNeedle` window is also correct but not
PROMPT: measured on a 500 ms/event SSE stream it delayed each 29-byte event by
1503 ms for a 53-byte API key, and withheld the final event until the connection
closed. A relay that streams bytes but not events fails every real user.

Two unsound alternatives, recorded so they are not re-invented: a **time-based
idle flush** emits the secret's PREFIX un-redacted and the guest reassembles the
raw value across two writes; a **`\n\n` delimiter flush** breaks on any
multi-line secret (every PEM contains the delimiter).

### 7.5.4b The end-of-stream sentinel — how truncation is signalled

A relay that has already sent its headers can still fail: the upstream socket
resets, `KORTIX_RELAY_UPSTREAM_IDLE_TIMEOUT_MS` fires, or the response byte
budget blows. The agent MUST be able to tell that answer apart from a complete
one.

Chunked framing does **not** provide that signal. Measured on bun 1.3.14 across
four shapes — the source `Readable` destroyed with an error, `controller.error()`,
`pull()` throwing, and a declared `content-length` cut short — Bun always writes
the final `0\r\n\r\n` and the client's `fetch` resolves cleanly. Raw wire bytes
off a `net.Socket` client, with the source destroyed mid-body:

```
HTTP/1.1 200 OK … Transfer-Encoding: chunked\r\n\r\n
12\r\nevent: a…\r\n12\r\nevent: b…\r\n0\r\n\r\n
```

So truncation is signalled **positively**:

- The shim asks for it (`meta.eos: true`). A daemon baked before this existed
  does not ask, gets no sentinel, and sees byte-for-byte the old wire — which is
  why the protocol version stays at **1**.
- The API mints `RELAY_EOS_BYTES` (32) random bytes per response, names them in
  `x-kortix-relay-status` (`eos`, hex), and appends them **only** on a clean
  flush of the response substituter. `flush()` does not run on an errored
  source, so their presence is exactly "the body completed".
- The shim holds back the last 32 bytes, strips them on a match, and on a
  mismatch **destroys the guest's TLS connection**. That is the only way to
  reach the guest: the same Bun behaviour applies on the shim → guest hop, so a
  clean 200 carrying half a document is what an errored stream would otherwise
  produce. `curl` reports `transfer closed with outstanding read data remaining`
  and exits non-zero.

The `secret.broker.completed` audit row is written at header time, before a
single body byte flows, so it can never assert completion. A second row,
`secret.broker.streamed`, is written when the body ends cleanly and carries
`response_bytes`, `complete: true`, and the FINAL substituted set. On a streamed
request body `completed` carries `substitution: "streamed_superset"` plus
`substitution_candidates` rather than an empty `substituted` — an operator must
never read "no secret was spent" for a hop that spent one.

### 7.5.4c Fail-closed on a compressed response

`prepareRelayHead` forces `accept-encoding: identity` upstream so the echo scan
sees plaintext. If the upstream answers with a `content-encoding` anyway, the
relay refuses with `502 upstream_encoding_unsupported` instead of piping bytes
the redactor provably cannot match. Decompressing server-side is the alternative
and is rejected: it reintroduces a decompression-bomb budget on a path whose
whole purpose is to have no size ceiling.

### 7.5.5 What did NOT change

Every security invariant is shared with the buffered path, not re-implemented:
https/443 only, no userinfo, per-hop `matchRule` re-admission, CRLF rejection,
the unsafe-target check, the post-substitution path re-match, forced
`accept-encoding: identity`, DNS-pinned egress IPs (which is why the upstream leg
uses `node:https` and not `fetch` — `fetch` cannot pin the resolved address and
would drop the DNS-rebinding guard), the `SAFE_RESPONSE_HEADERS` whitelist, and
echo redaction on BOTH the body and the whitelisted headers.

Redirect behaviour narrows in exactly one case: a `POST` with a body over
64 KiB, no handle anywhere, and a 3xx. The request stream is already consumed
and cannot be replayed, so it returns `502 redirect_not_replayable`. A redirect
after any secret is on the wire stays refused unconditionally, as before.

### 7.5.6 Transport selection and rollout

The shim probes ONCE at construction (`POST …/relay` with
`x-kortix-relay-probe: 1` → `204` + `x-kortix-relay: 1`). Anything else — a
`404` from an older self-hosted API, a `503 relay_disabled`, a timeout — pins
that shim to `/broker` for its whole process lifetime. It is a construction-time
probe and not a per-request one because **a streamed body that has already been
consumed cannot be replayed onto a fallback**. `syncEgressShim` rebuilds the
shim on a live capability push, so a re-probe happens naturally there.

Per-request fallbacks inside a relay-capable shim: `content-encoding: deflate`
takes the buffered path (its raw-vs-zlib ambiguity needs a retry that cannot be
done mid-stream) and keeps today's 1 MiB decompression-bomb guard; `gzip`,
`x-gzip` and `br` stream-decompress.

The probe is **not awaited at construction**. `startEgressShim` is awaited before
`startProxy()` binds the daemon's health port, so blocking there for the 5 s
probe timeout left `/kortix/health` answering nothing and every readiness poll
hitting a closed port. The probe is kicked off unawaited and the FIRST relayed
request awaits its result.

The verdict is **revisable downward, never upward**. A refusal that means
"/relay is not available here" — `404`, `501`, or `relay_disabled` — flips the
shim to `/broker` permanently, and a bodyless request (every GET/HEAD) is
replayed through `/broker` in the same turn. A `403 policy_denied` and every
other request-level refusal never change the transport. Without this, both
documented incident levers BROKE every running boundary-secret sandbox instead
of healing it: proven with a shim whose probe answered 204 and whose every
`/relay` then answered `503 relay_disabled` — two consecutive guest GETs both
returned 503 to the guest and zero requests reached `/broker`, which was up the
whole time.

Kill switch: `KORTIX_SECRET_RELAY_STREAM_ENABLED=false` makes `/relay` answer
`503 relay_disabled` with no image rebuild. New sessions revert to `/broker` at
their probe; already-running relay-mode sessions downgrade on their next call.

Deploy order is **API first** (both routes are additive and `/broker` is
byte-identical), then the sandbox image. Existing running sessions keep their
old daemon and old transport; nothing is forced to restart.

### 7.5.7 Accepted limits

- Header fidelity at the GUEST edge is lossy and cannot be fixed: Bun's parser
  lowercases names and collapses duplicate non-known headers to the LAST value.
  This is no worse than the buffered path, which dropped every multi-value
  header outright, and `x-kortix-relay-meta` prevents a SECOND collapse on the
  shim → API hop. The same collapse was measured on the RESPONSE leg
  (`res.rawHeaders` under Bun keeps only the last value for a repeated custom
  header); it costs nothing today because every name in `SAFE_RESPONSE_HEADERS`
  is single-valued and `set-cookie` is excluded from that list.
- Bun applies **no inbound flow control** — measured, a 200 MiB body into a
  50 ms/chunk consumer produced 12 chunks, one of 23,003,148 bytes. The byte
  budget in the read loop is the only guard; peak RSS is roughly 2x Bun's
  largest coalesced chunk. Do not write code that assumes a ~64 KiB chunk.
- A long-lived SSE relay holds decrypted values in the substituter for the life
  of the connection rather than milliseconds. `dispose()` zero-fills them.
  `flush()` is not enough on its own — a `TransformStream` flush runs ONLY on a
  clean close, so disposal is also tied to the request's abort signal, to the
  upstream body's `'error'`, and to the route's catch block. The guest still
  never sees the value, which is the invariant that matters.
- The handle-refusal classifier sees the URL and headers always, and the first
  64 KiB of the request body on EVERY branch: the buffered branch classifies the
  whole body, and both streaming branches tee a bounded prefix past the
  substituter. Feeding it only the buffered body made it a detection control the
  attacker could switch off at will, simply by declaring `body.length: null`.
  Beyond 64 KiB a refused handle is still NOT substituted — fail-closed is
  intact — but loses its forensic line.

## 8. Docs, skills, CLI — accuracy is a release gate

Every surface that describes secrets MUST describe THIS model, and only this model:

1. `apps/web/content/docs/project/secrets.mdx` — rewritten around exposure/usage. Include:
   - the sent-vs-computed distinction and WHY computed secrets stay `environment`;
   - "use egress-enforced as much as possible, environment as little as possible";
   - **the third-party guidance**: when exposing capabilities to UNTRUSTED third-party users,
     do not hand them secret policies at all — implement your own authorization + proxy
     service that receives their requests, applies your own authz, and makes the upstream
     calls with credentials it holds. Kortix secret policies protect a project's own agent;
     they are not a multi-tenant authorization system. This section is informational and
     must exist.
2. `apps/api/src/projects/secret-capabilities.ts` — the agent-facing catalog text (what the
   model reads in-sandbox) rewritten: handles, substitution, `[REDACTED]` echo semantics
   (ONE symptom set now — no more edge/shim branching, delete
   `NETWORK_BOUNDARY_NOTES_BLOCK`), `kortix secrets call` as the explicit fallback.
3. `apps/cli/src/commands/secrets.ts` — help text and errors match the model; `secrets call`
   stays; any copy naming "network boundary vs broker" as user choices is corrected.
4. Managed skills / starter docs that mention secrets — sweep and correct.
5. `docs/SECRET_DELIVERY_CONTROL_PLANE.md` — update the strategy table, the prerequisites
   (flag is gone), and the symptom table (one column now).
6. `docs/NETWORK_BOUNDARY_WITHOUT_PLATINUM.md` — append a dated status section pointing here;
   do not rewrite history.

The bar: a new reader must never encounter "network boundary" and "HTTPS broker" as two
choices anywhere — docs, UI copy, CLI help, in-sandbox capability text, or skills.

## 8.5. Threat model and limits

The security guarantee of egress-enforced delivery is **host-scoping**: the real
value only ever leaves Kortix toward a host on the secret's approved list, over
HTTPS/443. It is NOT a guarantee that an approved host cannot be tricked into
returning the value.

- **Echo redaction is best-effort, not a boundary.** The relay scrubs the real
  value from a response in four representations (raw, URL-encoded, base64,
  JSON-escaped). This defends against *accidental reflection* — a host that
  mirrors a request field back verbatim. It does NOT defend against an approved
  host chosen to *launder* the value: base64 at a shifted offset, split across
  JSON fields, XORed, re-encoded, or stored and returned later are all channels
  redaction cannot see. We deliberately do not add more encodings — the scan is
  unbounded and any fixed set is defeatable.
- **An approved host that stores agent-chosen bytes and returns them transformed
  is environment-equivalent** for that secret. Egress enforcement against such a
  host buys nothing over putting the value in the sandbox environment, because
  the agent can round-trip the value out through the host it was allowed to call.
- **Consequence for the operator:** approve a host ONLY if you trust it with the
  credential. Host-scoping limits *where* the value can go; it does not make a
  malicious or attacker-controlled approved host safe. When exposing capabilities
  to untrusted third parties, do not hand them secret policies at all (see §8,
  third-party guidance): run your own authorization + proxy service that holds
  the credential and applies your own authz.

## 9. Deliberately out of scope

- **Server-side signing** (SigV4, HMAC, JWT assertions). Computed secrets stay `environment`.
  Slots in later as a third exposure without touching this model.
- **Egress allow-listing** (blocking unapproved traffic). Separate feature; measured as
  not-worth-it behind Cloudflare anycast (see NETWORK_BOUNDARY doc §7.5).
- **Non-HTTP substitution** (Postgres URLs, SMTP). `environment`.
- **Placeholder for `none`-exposure secrets.** They have no sandbox presence at all.

## 10. Verification requirements (per repo standard — real inputs, real outputs)

1. **Substitution e2e on a real Daytona session**: `IDENTIFIER=<handle>` in `env`; unmodified
   `curl` and `python3 requests` to an approved echo host show the REAL value injected and
   `[REDACTED]` in the echoed body; the raw value appears nowhere in the guest; the handle
   sent to an UNapproved host arrives as the literal handle string; a forged-tag handle is
   not substituted and is audited as forged.
2. **Platinum session behaves identically** (shim armed, same symptoms).
3. **Legacy row compatibility**: a stored `inject` row still injects; a `broker`/`http_broker`
   row still serves `kortix secrets call`.
4. **Two secrets, one host** both substitute correctly in one request.
5. **Flag deletion**: no reference to `network_boundary_shim` remains
   (`grep -r network_boundary_shim` returns nothing outside this spec and the history doc).
6. **Web**: drive the real page — create environment + egress-enforced secrets, assert the
   outgoing payloads and the rendered labels; signing-credential warning renders for an
   `AKIA…` value.
7. **CLI**: real process runs of `kortix secrets` set/list/call against a running API.
8. `pnpm test` core lanes green; `--sdk-only` green if SDK touched; `tsc --noEmit` and eslint
   clean on touched files; `tests/src/flows/secrets.flow.ts` updated to the new contract and
   green; route manifest regenerated if routes changed.
