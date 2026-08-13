# Network-boundary secrets on Daytona

**Status:** mechanism built and proven end to end (§7.3, §7.4.1); not yet wired into
provisioning (§7.5)
**Author:** drafted 2026-08-11, substantially revised 2026-08-12 after measurement
**Problem owner:** production runs on Daytona; the feature exists only on Platinum

> **Read §7 before §3.** Several claims in the early sections were written from vendor docs
> and general knowledge, then disproved by measurement. Where they conflict, the measured
> result in §7 wins. The wrong claims are left in place with corrections attached rather than
> quietly edited, because the pattern of *how* they were wrong is the useful part.

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

Documented as *"the runner applies iptables rules to the sandbox container"* — i.e. on the
host, outside guest control. **We pass neither today.**

> **`outboundProxyUrl` does not exist.** An earlier draft listed it here as a third option
> and built all of Track B on it. It is absent from the pinned SDK's typings, and the API
> silently ignores it — see §7, which is now a settled negative result, not a pending
> experiment. Treat any vendor-proxy-chaining design as unavailable until Daytona ships the
> feature.

What Daytona does **not** have: a secret store, TLS termination, header injection, or any
`on_echo` equivalent. Zero of the ten Platinum primitives the boundary depends on. So the
feature cannot be ported provider-natively; it can only be **rebuilt** with Daytona supplying
the funnel and Kortix supplying the injection.

### 3.3 ~~The claim the whole design rests on~~ — settled, and it was moot

Daytona's docs state: *"Clients that do not respect `HTTP_PROXY` are blocked at egress."*

The original plan hung on whether that made `outboundProxyUrl` **enforced** or merely
**cooperative**. The question turned out not to matter: **`outboundProxyUrl` is not
implemented at all** (§7). The sentence in the vendor docs describes a feature this API does
not have.

Worth keeping as a marker: a whole architecture was designed around one sentence of vendor
documentation, and the field it referred to did not exist. The lesson generalises past this
doc — before building on a provider capability, send it a request that must fail if the
capability is real.

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
| **credential echoed by upstream** | connection cut (`on_echo`) | **redacted, response still returned** |
| transparent to the agent | **yes** | no — must call `kortix secrets call` |
| TLS interception needed | yes (Platinum's) | **none** |

On **confidentiality the broker is equal**, on **authorization and audit it is stronger**, and
it needs no MITM. Its only deficit is transparency. An agent that ignores the broker does not
get a weaker credential — it gets **no** credential.

**Correction to an earlier draft of this doc.** It claimed `on_echo` had no broker equivalent.
It does: `redactSecretFromResponse` (`apps/api/src/secrets/http-broker.ts:350`) scrubs the
value from the response body in four representations — raw, URL-encoded, base64, and
JSON-escaped — and returns the rest of the response normally. That is *better* than the
boundary's behaviour, not worse: Platinum kills the connection, which surfaces as
`curl: (52) Empty reply from server` and is the single largest source of "this feature is
broken" reports we have had (§4). The broker gives the agent a usable response with
`[REDACTED]` where the credential would have been. Verified live — see §5.1.

**Why customers do not have it: reach, not capability.** `kortix secrets call` is a string in a
system-prompt file, and models reach for tools far more reliably than for documented shell
commands.

### 5.1 Verified live on dev, 2026-08-12

Project `kaab-demo`, secret `BROKER_PROOF`, policy `broker`/`http_broker` with
`--allow-host postman-echo.com --allow-method GET --inject-header x-proof-token`. A real
session agent ran `kortix secrets call BROKER_PROOF https://postman-echo.com/get`:

```
Upstream status: 200
{"args":{},"headers":{"host":"postman-echo.com",…,"x-proof-token":"[REDACTED]",…}}
```

Three facts in one response: the header **arrived at the upstream** (so Kortix injected it
outside the sandbox), the call **succeeded** (200), and the echoed value came back
**redacted** rather than killing the connection.

The authorization gate was also observed working: before the agent's `secrets:` grant named
`BROKER_PROOF`, the identical call returned
`✗ secret delivery denied: agent_grant_excludes`.

**Caveat — this ran on Platinum.** `kaab-demo` inherits the dev platform default, which is
Platinum, so this proves the broker works but not yet that it works on Daytona. The broker
executes entirely in the API process (`http-broker.ts`) and touches no provider API, so
there is no mechanism by which the provider could matter — but that is an argument, not a
measurement, and this doc does not accept arguments where a measurement is available.
Daytona confirmation is tracked in §5.2.

### 5.2 The MCP tool, end to end — and the premise it disproved

`secret_call` verified live on dev (2026-08-12, commit `3d03cc68`), invoked as a real MCP
`tools/call` inside a sandbox:

```json
{"ok": true, "status": 200,
 "body": "{\"headers\":{\"x-proof-token\":\"[REDACTED]\", …},\"url\":\"https://postman-echo.com/get\"}"}
```

The tool works. **But the reason given for building it does not hold.** §6 argued that
`kortix secrets call` was unreachable in practice because "models reach for tools far more
reliably than for documented shell commands". Tested with a prompt that named neither the
tool nor the command — *"Fetch https://postman-echo.com/get with our BROKER_PROOF credential
attached"* — the agent went straight to the CLI on its first move:

> `BROKER_PROOF`: HTTPS broker. Use `kortix secrets call BROKER_PROOF <https-url> [options]`.
> So I need to use `kortix secrets call BROKER_PROOF https://postman-echo.com/get`.

One turn, `200`, header injected. It never considered the MCP tool — reasonably, because the
capabilities instruction it reads (`secret-capabilities.ts`) names the CLI command and says
nothing about a tool.

So the honest scoring of Track A step 1: the broker was **already discoverable** through the
instruction file, and the tool is a second door onto the same room rather than the first door
onto a locked one. It is still worth having (a host that only speaks MCP now has a path, and
tool calls are structured where shell output is not), but it was not the highest-leverage
change in this doc and this section should be read before anyone repeats that claim.

If the tool is meant to be the preferred path, the instruction renderer has to say so —
that is a one-line change in `secret-capabilities.ts`, not a new capability.

### 5.3 Where the broker is NOT equivalent to Platinum

Worth stating plainly, because a passing end-to-end test makes them look identical and they
are not:

| | Platinum boundary | broker (today, any provider) |
| --- | --- | --- |
| agent calls the API itself | works | works |
| a Python script the agent writes | **works** | **no credential** |
| a third-party SDK / CLI in the sandbox | **works** | **no credential** |
| `curl` in a Makefile, a test suite, a build step | **works** | **no credential** |

Platinum injects for *any* process making an allow-listed HTTPS request; the broker injects
only for requests routed through `secret_call` / `kortix secrets call`. Everything else in
the sandbox gets an unauthenticated request, not a failed one — which fails at the upstream
rather than locally, and is the more confusing failure.

Closing that gap is exactly Track B, and §6b establishes its precondition holds: Daytona's
egress control is enforced on the runner and root inside the guest cannot bypass it.

Note also that the agent, unprompted, described the broker's injection as happening "at the
network boundary". The two mechanisms are already being conflated in transcripts; the naming
in the product should separate them.

## 6. Recommendation — two tracks, in this order

### Track A — make the broker the production answer (start now, low risk)

The fastest path to a real capability for Daytona customers.

1. **Add an MCP tool** for the broker so the model discovers it the way it discovers everything
   else. **Done** — `secret_call` in `apps/cli/src/connector-gateway/mcp.ts`.

   This step was written on a false premise and the premise had to be fixed first. The doc
   assumed the `kortix-connectors` MCP server was a live surface with eight tools on it. It is
   not, for two independent reasons found while implementing:

   - **It was broken.** The daemon registered `kortix connector mcp` (singular) while the CLI
     only routes `connectors`. OpenCode's launcher got `unknown command` and exit 2, so the
     server never started. Introduced by e868be1d6c on 2026-08-06 — the same commit that
     renamed `executor` → `connectors` — and invisible because the daemon's unit tests were
     updated to assert the typo'd literal. Fixed, with a CLI-side guard that now runs the argv
     the daemon registers and requires a clean JSON-RPC handshake.
   - **It is disabled.** `KORTIX_CONNECTORS_MCP_ENABLED` appears in tests and nowhere else —
     no values.yaml, no env profile. The CLI is the deliberate agent-facing default
     (87ad9a3665, "refactor executor to prefer cli surface").

   So `secret_call` is correct and tested but reaches no production agent until that flag is
   turned on. **That flag flip is a product decision, not a bug fix** — it adds nine tools to
   every agent's context — and is deliberately left to the owner rather than taken here.
   Until then the live channel for broker discovery remains the capabilities instruction file
   (`/tmp/kortix/secret-capabilities.md`), which already names `kortix secrets call`.
2. **Stop offering `egress` on projects that cannot run it.** Already partly done — the UI now
   gates on the project's active provider — but the *strategy picker* should present the broker
   as the Daytona-native option rather than showing a disabled control.
3. ~~**Fix the dead limb**: `broker`/`git_proxy` advertises `delivery_status:'available'`
   while no execution path implements it.~~ **Withdrawn — the claim was false.** `git_proxy`
   is consumed at `apps/api/src/projects/lib/git.ts:569`, which resolves the git credential
   server-side for push/pull. It is narrow (one call site, one fixed key
   `KORTIX_GIT_AUTH_TOKEN`) but it is live. And `delivery_status` documents itself, in a
   comment directly above the branch, as "does this *deployment* support the mode" — not
   "will this particular secret be consumed" — so `available` is the correct value under the
   field's own semantics. Nothing to fix.
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

## 7. The blocking experiment — RUN. Result: `outboundProxyUrl` is ignored

Run 2026-08-12 against `app.daytona.io/api` on throwaway sandboxes from
`kortix-default-b539f1be09d3`, control vs treatment, deleted after.

Treatment set `outboundProxyUrl` to `http://198.51.100.7:3128` — RFC 5737 TEST-NET-2, which
cannot route anywhere. If the runner forced egress through it, every request would die.

| probe | control (no options) | `outboundProxyUrl` set |
| --- | --- | --- |
| `curl https://api.github.com/rate_limit` | 200 | **200** |
| `curl --noproxy '*'` | 200 | 200 |
| `$HTTPS_PROXY` / `$https_proxy` in guest | unset | **unset** |
| raw Python socket to `140.82.121.6:443` | CONNECTED | CONNECTED |
| DNS | RESOLVED | RESOLVED |
| `sudo -n curl` (root) | 200 | 200 |

Identical in every cell. The field is not enforced and not even **applied** — the runner
does not so much as set the proxy env var. Consistent with the API validator, which is
lenient about unknown properties: a deliberately invented `zzTotallyMadeUpField` produced
no complaint either, so a clean 200 on create says nothing about a field being real.

**Consequence: the transparent-redirect architecture in §6 Track B is unbuildable as
written.** Daytona gives us a funnel we can close (§6b) but no vendor mechanism to redirect
traffic into a proxy.

### 7.1 What Track B has to look like instead

Split the two properties, because on Daytona they now come from different places:

- **Enforcement** comes from `networkAllowList` restricted to the Kortix proxy's address.
  Runner-applied, root-proof, already measured (§6b). Nothing escapes the guest, ever.
- **Transparency** cannot come from the runner. The guest has to be *pointed* at the proxy:
  `HTTPS_PROXY`/`HTTP_PROXY` in the sandbox env, and for clients that ignore those, an
  `LD_PRELOAD` socket shim (proxychains-style).

The pleasant property of that split: the transparency layer is removable and its removal is
**fail-closed**. An agent that unsets `HTTPS_PROXY` does not gain a bypass — the allow-list
still permits only the proxy, so it simply loses network. Security does not depend on the
part the guest can touch.

The unpleasant one: **in-guest transparent redirect is impossible**, so any client that
honours neither the env var nor the shim gets no network at all. That is not hypothetical —
Node/Bun `fetch` (undici) ignores `HTTP_PROXY` by default, and agents write `fetch` code
constantly. Note also that in-guest `iptables` is doubly out: it is absent from the image
*and* the container holds no capabilities (`CapEff: 0000000000000000`, §3.1), so even root
cannot install a redirect rule.

So the honest positioning of Track B on Daytona is **enforced, selectively transparent** —
strictly weaker on ergonomics than Platinum, identical on confidentiality. Any UI copy must
say which one a project is getting.

### 7.2 Phase-1 measurements — RUN 2026-08-12

Control-vs-treatment on throwaway sandboxes from `kortix-default-b539f1be09d3`.

**`domainAllowList` does nothing.** With `domainAllowList: 'api.github.com'`, the listed
host, an unlisted host, and a raw IP all returned 200 for both the user and root —
byte-identical to a sandbox created with no options at all. Like `outboundProxyUrl`, the
API accepts it and drops it. Only `networkBlockAll` and `networkAllowList` are real.

> A first pass at this looked like an *inverted* allow-list (listed host `000`, unlisted
> host `200`, root reaching what the user could not) and would have gone into this doc as a
> security finding. It was a transient `curl 000`. Every probe here is now three
> repetitions; single-shot `curl` exit codes are not evidence.

**A CIDR allow-list needs the DNS resolvers in it.** This is the load-bearing result:

| create option | github | example.com | DNS | root → github |
| --- | --- | --- | --- | --- |
| `networkAllowList: 140.82.112.0/20` | 000 | 000 | **timeout** | 000 |
| `…/20` + `1.1.1.1/32,8.8.8.8/32,169.254.0.0/16` | **200** | **000** | RESOLVED | 200 (listed host) |

With the resolver ranges added, the funnel behaves exactly as Track B needs: the listed
destination is reachable, everything else is refused, and root is refused too.

**The funnel can be closed on a RUNNING sandbox.** `sandbox.updateNetworkSettings({
networkBlockAll: true })` on a live, previously-open sandbox took effect immediately — all
egress, DNS, and root egress went to 000 without a restart.

**Upstream IPs are not stable.** `api.github.com` resolved to `172.182.252.137` in one
sandbox and `140.82.112.6` in another, and the resolver set itself varied
(`1.1.1.1 / 1.0.0.1 / 100.65.160.1` vs `1.1.1.1 / 1.0.0.1 / 8.8.8.8`). Allow-listing an
*upstream* by CIDR is therefore unreliable by construction. Allow-listing **our own proxy**
is not — we own that address. This is another reason the design must funnel through a proxy
rather than try to express policy as vendor allow-list entries.

**Consequence for the guest's DNS:** none needed. The allow-list pins the proxy by IP and
`HTTPS_PROXY` names that IP, so the guest never resolves anything; the proxy resolves
upstream names on its behalf. That sidesteps the resolver variability entirely.

### 7.3 The proxy — built, and proven in a real Daytona guest

`apps/api/src/secrets/egress-proxy/` (`ca.ts`, `proxy.ts`). CONNECT to a host carrying an
injection rule is terminated with a per-sandbox ephemeral CA, the header is added, and the
credential is redacted from the response. A host with no rule is tunnelled blind.

11 tests, no mocks: real HTTPS upstream, real CONNECT, real interception. Live run on a
throwaway Daytona sandbox (`kortix-default-b539f1be09d3`), proxy bundled and executed inside
the guest, CA installed into the system store with `update-ca-certificates`:

```
curl/8.5.0            {"headers":{…,"x-proof-token":"[REDACTED]",…},"url":"https://postman-echo.com/get"}
python-requests/2.34.2 {"headers":{…,"x-proof-token":"[REDACTED]",…}}
api.github.com (no rule) -> 200      # tunnelled untouched
credential in guest env  -> 0 occurrences
```

Two independent TLS stacks (curl/OpenSSL and python-requests) both accepted the ephemeral CA
and both reached the upstream **with the credential attached, having never held it**. The
`[REDACTED]` in the echo is the response-scrubbing working on the same request — injection
and echo-protection demonstrated in one call.

> **What this run does and does not show.** The proxy ran *inside* the sandbox, which is not
> where it runs in production. Its location is not what was under test: enforcement is the
> allow-list's job and was measured separately (§7.2). What this shows is that the injection
> mechanism survives contact with a real Linux guest — cert trust, ordinary HTTP clients, a
> real upstream. Note also that the credential was present in the guest in this run, inside
> the proxy bundle itself; in production that bundle is not in the guest.

Two runtime divergences shaped the implementation and are worth knowing before anyone
refactors it — both measured, both silent failures rather than errors:

- **`http.Server.emit('connection', socket)` is a no-op under Bun.** The canonical way to run
  an HTTP parser over a socket you already own does nothing; the request event never fires
  and the connection hangs. The same script works under Node.
- **`SNICallback` never fires under Bun.** The handshake completes against a default
  certificate instead, so a single listener choosing certs per SNI cannot work.

Hence: a real loopback TLS listener per terminated host, each with a static leaf.

### 7.4 Where the proxy runs — split it, and the answer falls out

The obvious reading of §7.3 is "stand up a public Kortix proxy service": new deployment, new
TLS surface, a stable address to pin, and Kortix terminating customer traffic at a brand-new
internet-facing box. That is a lot of new exposure for a credential-handling MITM.

There is a better shape, and it comes from noticing that the proxy does two separable jobs:

1. **Terminate the guest's TLS** so an ordinary client can be intercepted. Must happen
   *inside* the guest — it is the guest's own connection.
2. **Hold the credential and call the upstream.** Must happen *outside* the guest.

Nothing requires those to be the same process. Split them:

```
guest client ──HTTPS──▶ in-guest shim ──HTTPS──▶ Kortix API ──▶ upstream
                        (ephemeral CA;            (holds the credential,
                         holds NO secret)          injects, redacts)
```

The in-guest shim is the proxy in this directory with its injection step replaced by a call
to the existing broker route — the one already proven end to end in §5.1. It terminates TLS,
reads the request, and relays it to Kortix, which does what it already does today: resolve
the secret, apply the host/method policy, inject, perform the request, redact the echo.

Why this is the better answer here:

- **No new public infrastructure.** Sandboxes already reach the Kortix API — it is how every
  session works. The allow-list pins that address, which we already own and which is stable.
- **The in-guest component holds no secret.** It is fully untrusted. An agent that reads it,
  patches it, or kills it learns nothing; under the allow-list, killing it costs the agent
  its own networking. Fail-closed, and security never rests on guest-side code.
- **Kortix does not MITM arbitrary traffic.** Only requests the shim relays reach us, and only
  policy hosts have rules. We are not terminating the whole internet on a shared box.
- **It reuses a proven path.** The broker is shipped, tested, and verified live; this makes it
  transparent rather than replacing it.

The consequence to state plainly: with the allow-list pinned to Kortix, a session in boundary
mode can reach **only its approved hosts**. That is stricter than Platinum, which permits
general egress alongside injection. Stricter is defensible — arguably it is the posture a
"network boundary" should have had all along — but it is a behaviour difference, not parity,
and the UI has to say so.

#### 7.4.1 The shim, proven end to end

Built as a second rule mode on the same proxy (`mode: 'broker'`), so the CONNECT and
TLS-termination machinery is the code already tested in §7.3 rather than a parallel
implementation. Run inside a **real Kortix session** against the **real dev broker**, with an
unmodified `curl` and `https_proxy` pointed at the local shim:

```
SHIM_READY
--- ca: done.
--- curl through the shim:
{"args":{},"headers":{"host":"postman-echo.com","accept":"*/*",
 "x-proof-token":"[REDACTED]","user-agent":"curl/8.5.0", …},
 "url":"https://postman-echo.com/get"}
```

The chain: unmodified client → in-guest shim (terminates TLS, holds nothing) → Kortix broker
(holds the credential, injects, redacts) → real upstream. **The credential reached the
destination and was never in the guest.** That is the Platinum property, on a provider with
no credential edge of its own.

`[REDACTED]` is the broker's server-side scrub of the echoed value, so injection and
echo-protection are both visible in the one response.

Caveats, stated rather than implied:

- This session was Platinum-backed (`kaab-demo` follows the dev default). The shim is
  provider-agnostic by construction — it is in-guest code plus HTTPS to the Kortix API, and
  touches no provider surface — but "provider-agnostic by construction" is an argument, and
  the Daytona re-run is pending only because dev Daytona provisioning is currently failing
  (`/start` succeeds, the sandbox never reaches running).
- No allow-list was applied in this run. Enforcement was measured separately (§7.2); this run
  measured injection.

### 7.5 Wiring — what is done, what is left

#### Done: the server half (behind the `network_boundary_shim` project flag, default OFF)

Three gates stood between a non-Platinum project and this feature.

1. **The relay route.** `POST /projects/:id/secrets/:identifier/broker` rejected anything that
   was not `strategy:'broker'`. It now also accepts `egress`/`network`. This cost almost
   nothing: a boundary policy *is* a `SecretEgressPolicy`, and `prepareSecretBrokerRequest`
   reads only `rules` and `inject` — never `backend` — so the existing engine executes it
   unchanged. The policy is re-validated at request time rather than trusted from the row.
   Audit metadata now derives the consumer instead of hardcoding `http_broker`.
2. **`networkBoundaryDeliveryAvailable()`** was `config.isPlatinumEnabled()` alone. That one
   expression is why no production project could ever use this feature.
3. **The provider gate — in TWO places.** `startNetworkBoundaryArm`
   (`projects/lib/sandbox-env-sync.ts`) and a duplicated pre-check in
   `platform/services/session-sandbox.ts`, sharing a message string. Relaxing only the first
   still fails provisioning, one frame later. Both now consult the shim. The post-create call
   also dropped a `provider.syncNetworkBoundary!` non-null assertion that was safe only while
   the pre-check guaranteed the method existed — with a shim-backed provider reaching it, that
   would have been a TypeError at provision time instead of a clean skip.

**It is a per-project experimental flag, not an operator env var.** The first version was
`EGRESS_SHIM_ENABLED`, an env var, which was wrong twice over. It made the smallest testable
unit the whole deployment, and it put the switch in the infrastructure repo — so verifying the
feature on dev required a GitOps change before anyone could see whether it worked at all. The
registry entry (`feature-flags/registry.ts`, `stability: 'experimental'`) is toggled through
the existing Feature flags UI and `PATCH /projects/:id/experimental`, so one project can opt in
and be proven before anything else is exposed to it.

**It still defaults OFF deliberately.** Turning it on makes the API *advertise* boundary
delivery — the save gate, `delivery_status`, and the web control all read it. Until the guest
actually runs the shim, that is a feature that looks available and silently does nothing, which
is the failure this whole document exists to unpick. What the flag really asserts is "this
project's sandbox image runs the shim", a fact the API cannot introspect. Turn it on once a
fresh sandbox has been *observed* running the shim, not merely once the code is merged.

#### Left: the guest half

1. **Ship the shim and start it.** No new image artifact is needed — the daemon already ships
   in the image and already starts child processes, so it can host the shim. It needs the
   session token, project id, and the host->identifier rules (no values).
2. **Trust the CA.** Install the ephemeral CA into the system store *and* the per-runtime env
   vars. §7.6 measured which ones actually matter.
3. **Point the clients.** `HTTPS_PROXY` plus `NODE_USE_ENV_PROXY=1` and `REQUESTS_CA_BUNDLE`.
4. **Optional: the allow-list.** Not required for the security property — an agent that
   bypasses the shim gets an *unauthenticated* request, not a credential — so it is egress
   restriction, a separate feature. It also needs a stable Kortix egress address, which
   `dev-api` (Cloudflare-fronted) does not provide.

The web gate moved into the *done* half along with the flag. `networkBoundaryAvailability`
(`apps/web/.../secret-delivery.ts`) reads `project.experimental.network_boundary_shim` and
short-circuits the provider question when it is on, because the shim runs nowhere near a
provider edge. Both blocked-state messages now name the flag: neither state says "not available
in this deployment" any more, because neither is true — both are one opt-in away.

`buildSecretView` takes the project metadata through an OPTIONAL argument, which is a trap
worth naming: a caller that omits it still typechecks and silently reports the pre-flag
Platinum-only answer. `loadSecretViewsForUser` therefore looks the metadata up itself rather
than making five routes remember to pass it — only two of them have the project row in scope.

#### Blocked on infrastructure, not code

- **Dev Daytona provisioning is failing** (`/start` succeeds, the sandbox never reaches
  running), which blocks the Daytona re-run of §7.4.1.
- **The Daytona snapshot quota is exhausted** — 225 of 200 — so every CI run that builds a
  snapshot fails, on any PR. Deleting all 18 CI snapshots only reaches 207; the bulk is live
  product data (`kortix-meta-*` 117, `kortix-app-*` 38). Needs a quota raise or a retention
  policy.


- **Provisioning wiring.** Mint the CA per session, push it into the guest trust store plus
  the ~11 per-runtime env vars, set `HTTPS_PROXY`, and set `networkAllowList` to the proxy.
- **Allow-list survival across resume / CoW-restore** — the funnel must not open on restore.
- **Clients that ignore `HTTPS_PROXY`** (notably Node/Bun `fetch`) reach nothing once the
  allow-list is on. Needs either an `LD_PRELOAD` shim or honest documentation.

## 8. What I would not build

- **In-guest iptables enforcement.** Dead on both providers (§3.1). Even granting `NET_ADMIN`
  is self-defeating while the agent holds `NOPASSWD:ALL`.
- **Blanket TLS interception.** Breaks pinned clients and mTLS, and makes us MITM for traffic
  that has nothing to do with any secret.
- **`HTTP_PROXY` alone, sold as a boundary.** Every prior-art implementation warns against it,
  and it would be a security claim we cannot support.

## 9. Open questions

1. Does `outboundProxyUrl` actually block non-conforming clients? (§7 — blocking)
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

### 7.6 Which in-guest clients actually honour the proxy — measured

Once the allow-list permits only the proxy, a client that ignores `https_proxy` reaches
**nothing**. §7.1 asserted from general knowledge that Node/Bun `fetch` was the problem case.
Measured in a real guest, that was half wrong:

| client | routed through the proxy? |
| --- | --- |
| `curl` 8.5.0 | yes |
| `bun` `fetch` | **yes** — the earlier claim that it would not was wrong |
| `node` `fetch` (undici) | **no**, goes direct |
| `node` with `NODE_USE_ENV_PROXY=1` | **yes** |
| `python3` `requests` | yes, but needs `REQUESTS_CA_BUNDLE` or it fails cert verification |
| `git` 2.43.0 | yes — **after fixing a bug in this proxy**, below |

So the mitigation is a handful of environment variables set at provision — `NODE_USE_ENV_PROXY`,
`REQUESTS_CA_BUNDLE`, and the rest of the per-runtime CA vars — not an `LD_PRELOAD` shim. That
is a much smaller and much less fragile piece of work than §7.1 assumed.

**The git bug, because it is the kind that only real clients find.** `git` sends
`CONNECT`, receives the 407 challenge, and retries with credentials **on the same
connection** (`Proxy-Connection: Keep-Alive`). Node hands the raw socket to the `connect`
handler, so after the 407 nothing is parsing that socket and the retry went into the void:
`fatal: unable to access …: Proxy CONNECT aborted`. Every clone, fetch, and push through the
proxy failed, while `curl` was unaffected because it opened a new connection.

The fix is two headers on the 407 — `Content-Length: 0` and `Connection: close` — telling the
client to reconnect rather than reuse. Verified after the change: `git ls-remote` returns the
real SHA and `git clone` completes, with injection and blind tunnelling both still correct.
Pinned by a regression test that asserts the framing.
