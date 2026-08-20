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
