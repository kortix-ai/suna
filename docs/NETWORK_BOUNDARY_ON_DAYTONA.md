# Network-boundary secrets on Daytona

**Status:** proposal, awaiting one blocking experiment
**Author:** drafted 2026-08-11
**Problem owner:** production runs on Daytona; the feature exists only on Platinum

---

## 1. The problem in one paragraph

A *network-boundary* secret (`strategy:'egress'`, `consumer:'network'`) is delivered by the
**Platinum** sandbox provider: Kortix registers the credential with Platinum at session
provision, and Platinum's egress proxy terminates TLS and injects a header on outbound
requests to allow-listed hosts. The sandbox never receives the value — no env var, no alias,
no placeholder. **Production runs on Daytona**, where
`syncProviderNetworkBoundary` throws `Sandbox provider daytona does not support
network-boundary secret delivery`. So no paying customer can use the feature.

## 2. What we are actually protecting against

Two different goals get conflated. Separating them decides the architecture.

| Goal | Statement | Who it defends against |
| --- | --- | --- |
| **Confidentiality** | The agent never possesses the credential | a leaky or compromised agent, prompt injection, logs, `env` dumps |
| **Transparency** | The agent uses an ordinary HTTP client and the credential appears in flight | developer effort; nothing security-related |

Platinum's boundary delivers both. **Most of the value is confidentiality.** Transparency is
ergonomics. This matters because we already ship a confidentiality-equivalent mechanism that
works on Daytona today (§5).

## 3. Measured facts

Everything here was probed on live dev sandboxes on 2026-08-11, not read off a doc.

### 3.1 Guest privilege — the same on both providers

| | Platinum | Daytona |
| --- | --- | --- |
| PID 1 | `pt-init` as **root** | `daytona` as `kortix` (uid 1001) |
| own kernel | yes (`kthreadd`, `kworker` visible) | no — Docker, bridge `172.20.0.0/16` |
| agent uid | `kortix` (1001) | `kortix` (1001) |
| `CapEff` / `CapPrm` | `0000000000000000` | `0000000000000000` |
| **`sudo -n id`** | — | **`uid=0(root)`** |
| `iptables` / `nft` in image | absent | absent |
| direct egress | — | works (200 to `api.github.com`) |
| CA store agent-writable | — | no (but sudo makes that moot) |

**The agent has passwordless root** (`apps/sandbox/Dockerfile:94-96`, `NOPASSWD:ALL`). An
earlier draft of this analysis claimed the agent was unprivileged and that a root-owned boot
step could install egress rules it could not remove. That was wrong — a silent `sudo -n true`
was misread as failure. Any in-guest rule is removable with `sudo iptables -F`.

> **Conclusion:** in-guest enforcement is not viable on **either** provider. Enforcement must
> live outside the guest.

### 3.2 What Daytona offers outside the guest

The pinned SDK (`@daytonaio/sdk@0.184.0`) exposes, at create **and** live via
`sandbox.updateNetworkSettings()`:

- `networkBlockAll` — default-deny egress
- `networkAllowList` — CIDR allow-list
- `outboundProxyUrl` — chain egress to a proxy **you** operate

Documented as *"the runner applies iptables rules to the sandbox container"* — i.e. on the
host, outside guest control. **We pass none of these today.**

What Daytona does **not** have: a secret store, TLS termination, header injection, or any
`on_echo` equivalent. Zero of the ten Platinum primitives the boundary depends on. So the
feature cannot be ported provider-natively; it can only be **rebuilt** with Daytona supplying
the funnel and Kortix supplying the injection.

### 3.3 The claim the whole design rests on

Daytona's docs state: *"Clients that do not respect `HTTP_PROXY` are blocked at egress."*

If true, `outboundProxyUrl` is an **enforced** chaining point and a Kortix-operated proxy gets
the same class of guarantee as Platinum. If false, it is **cooperative** and a determined agent
walks around it. **This is unverified and is the first thing to test** (§7).

## 4. Prior art

The pattern is well-trodden; we should position against it rather than invent.

- **Anthropic's Claude Code sandbox** — `credentials.envVars` with `mode:"mask"`, `injectHosts`,
  `network.tlsTerminate`. Closest public analogue to what we want.
- **Vercel Sandbox** — credential brokering + a documented firewall model.
- **Cloudflare Sandbox** — outbound Workers.
- **IETF draft "Credential Broker for Agents" (CB4A)**, Model A "Proxy Gateway" — names the
  pattern.
- **CyberArk Secretless Broker**, **Vault Agent/Proxy**, **Envoy ext_authz**, **Squid/mitmproxy
  with a private CA** — the older generation.

Convergent design across all of them:

1. Terminate TLS **only** for hosts that have an injection rule; never blanket-MITM.
2. Mint a **per-sandbox ephemeral CA**, push it into the system trust bundle *and* the ~11
   per-runtime env vars (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, …).
3. Enforce at the host/hypervisor, **never with `HTTP_PROXY` alone**.
4. Give the guest a **placeholder**, not nothing, so tools that read the variable still work.

Two places we are unusual:

- **"Guest sees nothing at all"** is the strictest variant. Most vendors substitute a
  placeholder. Ours breaks any tool that insists on reading the env var.
- **`on_echo` response blocking appears to be genuinely rare.** No vendor found documents it.
  One (iron-proxy) explains why: buffering responses end-to-end to scan them stalls the client.
  Ours cuts the connection instead, which is cheaper but produces `curl: (52) Empty reply` —
  the single biggest source of "this feature is broken" reports we have had.

## 5. The option we already own

`strategy:'broker'` + `consumer:'http_broker'` (backend `kortix_fetch`) is **provider-agnostic
and works on Daytona today**. Route `POST /v1/projects/:projectId/secrets/:identifier/broker`,
executed by `apps/api/src/secrets/http-broker.ts` from the API process. Verified on a live
Daytona session: saves clean, `delivery_status: 'available'`, and the in-sandbox `kortix` CLI is
session-authenticated.

Compared with the network boundary:

| | boundary (`egress`/`network`) | broker (`broker`/`http_broker`) |
| --- | --- | --- |
| credential in sandbox | never | never |
| works on Daytona | **no** | **yes, today** |
| host matching | exact only | wildcards, paths, methods |
| injection slots | one header | header, query, JSON body |
| per-request audit | no | **yes** |
| transparent to the agent | **yes** | no — must call `kortix secrets call` |
| TLS interception needed | yes (Platinum's) | **none** |

On **confidentiality the broker is equal**, on **authorization and audit it is stronger**, and
it needs no MITM. Its only deficit is transparency. An agent that ignores the broker does not
get a weaker credential — it gets **no** credential.

**Why customers do not have it: reach, not capability.** `kortix secrets call` is a string in a
system-prompt file. There is no MCP tool for it
(`apps/cli/src/connector-gateway/mcp.ts` has eight connector tools and no secret tool), and
models reach for tools far more reliably than for documented shell commands.

## 6. Recommendation — two tracks, in this order

### Track A — make the broker the production answer (start now, low risk)

The fastest path to a real capability for Daytona customers.

1. **Add an MCP tool** for the broker so the model discovers it the way it discovers everything
   else. Highest-leverage single change in this doc.
2. **Stop offering `egress` on projects that cannot run it.** Already partly done — the UI now
   gates on the project's active provider — but the *strategy picker* should present the broker
   as the Daytona-native option rather than showing a disabled control.
3. **Fix the dead limb**: `broker`/`git_proxy` advertises `delivery_status:'available'`
   (`apps/api/src/projects/lib/serializers.ts:451`) while no execution path implements it.
4. **Docs**: one page, "which delivery mode do I want", with the table from §5.

### Track B — an enforced Kortix egress proxy (gated on the §7 experiment)

Daytona supplies the non-bypassable funnel; Kortix supplies everything Platinum's edge does.

```
guest ──(runner iptables: block-all + allow only proxy)──▶ Kortix egress proxy ──▶ upstream
                                                            │
                                                            ├─ per-sandbox ephemeral CA
                                                            ├─ inject header for policy hosts
                                                            ├─ pass through everything else
                                                            └─ on_echo response handling
```

Non-negotiables:

- **Selective termination.** MITM only hosts with an injection rule. Everything else is
  `CONNECT`-tunnelled untouched. This bounds the blast radius and avoids breaking pinned TLS.
- **Ephemeral per-sandbox CA**, minted at provision, destroyed with the sandbox. Never a
  long-lived Kortix root in a customer image.
- **We become a credential-handling MITM.** That is a real compliance and blast-radius change
  and must be an explicit decision, not a side effect. Document the threat model before code.
- **Honest labelling.** If the §7 experiment fails, the UI must say *cooperative on Daytona,
  enforced on Platinum* — in the product, not only in docs.

## 6b. EXPERIMENT RESULT — the funnel is real and root-proof

Run 2026-08-11 against `api.daytona.io` with a throwaway sandbox on
`kortix-default-b539f1be09d3`, driving the SDK directly (no Kortix code in the path).

**`networkBlockAll: true`**

| probe | result |
| --- | --- |
| `curl https://api.github.com/rate_limit` | `000` |
| `curl --noproxy '*'` | `000` |
| raw Python socket to `140.82.121.6:443` | **Connection refused** |
| DNS (`getent hosts`) | timeout |
| **`sudo -n curl`** (as **root**) | **`000`** |
| `sudo -n iptables -F` | `iptables: command not found` |
| control: same sandbox, `networkBlockAll: false` | all **200 / CONNECTED** |

**`networkAllowList: 140.82.112.0/20`** (GitHub's range; `networkBlockAll` must be OFF —
the two are mutually exclusive, `400 DaytonaValidationError`)

| probe | result |
| --- | --- |
| allowed CIDR, by IP | **200** |
| allowed host **by DNS name** | `000` |
| `1.1.1.1`, `example.com` | `000` |
| **root**, not-allowed host | `000` |

**Verdicts**

1. **Daytona's egress control is enforced on the runner and root inside cannot bypass it.**
   `iptables` is not even present in the guest because the rules do not live there. This is a
   genuine non-bypassable funnel — the precondition for Track B. The `outboundProxyUrl`
   enforcement claim no longer has to be taken on faith; the same mechanism demonstrably holds
   against root.
2. **`networkBlockAll` and the allow-lists are mutually exclusive.** Allow-list mode is
   `networkAllowList` alone. The SDK error also reveals a `domainAllowList`, which is not in the
   typings we read and should be investigated — a domain allow-list would solve DNS more cleanly
   than a CIDR one.
3. **DNS is the first real design constraint.** With a CIDR allow-list, name resolution fails —
   the resolver is not in the list, so only literal IPs work. Track B must either allow the
   resolver explicitly, resolve names at the proxy (guest sends `CONNECT host:443` to the proxy
   and never resolves anything itself), or use `domainAllowList`. **Proxy-side resolution is the
   right answer** and is what the prior art does.

## 7. Remaining experiment — `outboundProxyUrl` specifically

§6b removes the risk from this, but the proxy path itself is still unexercised.

1. Create a Daytona sandbox with `outboundProxyUrl` pointed at a sink we control.
2. From inside the guest, attempt egress that deliberately ignores the proxy:
   - `curl --noproxy '*' https://api.github.com/rate_limit`
   - a raw Python socket to a public IP on 443
   - an outbound SSH connection
   - the same three again after `sudo -i`
3. **If all are dropped** → proceed. (§6b already shows the enforcement mechanism holds against
   root, so the expected answer is yes; this confirms it for the proxy-chaining path specifically.)
4. **If any succeeds** → belt-and-braces: pin egress with `networkAllowList` restricted to the
   proxy's CIDR, which §6b proves is enforced. Either way Track B is viable.

Secondary experiments, only if (3): `networkBlockAll` + `networkAllowList` restricted to the
proxy CIDR, live `updateNetworkSettings()` on a running sandbox, and behaviour on
resume/CoW-restore.

## 8. What I would not build

- **In-guest iptables enforcement.** Dead on both providers (§3.1). Even granting `NET_ADMIN`
  is self-defeating while the agent holds `NOPASSWD:ALL`.
- **Blanket TLS interception.** Breaks pinned clients and mTLS, and makes us MITM for traffic
  that has nothing to do with any secret.
- **`HTTP_PROXY` alone, sold as a boundary.** Every prior-art implementation warns against it,
  and it would be a security claim we cannot support.

## 9. Open questions

1. Does `outboundProxyUrl` block non-conforming clients on its own? (§7 — no longer blocking:
   `networkAllowList` is proven enforced and can pin egress to the proxy regardless.)
1b. What is `domainAllowList`? It appears in a server-side validation error but not in the
   typings we read. A domain allow-list may remove the DNS problem entirely.
2. Are we willing to operate a credential-handling MITM for customer traffic, with the
   compliance surface that implies?
3. Should the guest get a **placeholder** instead of nothing, matching the rest of the industry?
   It would fix tools that insist on reading the variable, at the cost of our strictest property.
4. Can `on_echo` be preserved through a Kortix proxy without stalling responses, or do we accept
   header-only protection off Platinum?

## 10. Related

- `docs/SECRET_DELIVERY_CONTROL_PLANE.md` — the shipped control plane
- `apps/web/content/docs/project/secrets.mdx` — the user-facing explainer
- `.claude/skills/learnings/SKILL.md` — "A per-turn hot path must not contain an unbounded
  third-party round-trip", the incident that came out of this feature
