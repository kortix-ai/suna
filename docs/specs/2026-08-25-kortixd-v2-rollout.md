# kortixd v2 — what to change, and in what order

Status: **PROPOSED**. Date: 2026-08-25.
Amends `docs/specs/2026-08-21-kortixd.md`. That spec stays authoritative for
**what** kortixd is. This document changes four things about **how it is built**
and replaces its §11 phase order.

---

## The core, in one sentence

> **A Kortix session must be able to run on any machine. kortixd is what makes a
> session's home a variable instead of a three-value enum.**

The two lines from the thread are the goal and its mechanism:

> *Single binary that makes any compute be kortix-compute. Aka be able to use it
> for its agent runtime/shell/fs/cua.*
>
> *It's like the computer agent tunnel we have today. It connects to the
> kortix-api as a relay server & opens it up entirely for 2 way comms.*

"Like the computer agent tunnel" describes the **transport**, and that is the
only part of agent-tunnel that carries over. The distinction matters, because it
is the one this document previously got wrong:

| | Agent Tunnel today | kortixd |
| --- | --- | --- |
| Where the session lives | in a Kortix sandbox | **on the machine** |
| What the machine is | a **peripheral** the agent reaches into for shell / fs / desktop | the **compute** the agent runs on |
| If the machine is gone | the session continues without that tool | the session must be re-placed |

Adding a `runtime` capability beside `shell | filesystem | desktop` would still
make the machine a peripheral that can also start a process. It is not enough.
The session itself — agent runtime, workspace, turn loop — has to be hosted
there.

### What "hosted there" actually requires

The spec's §1 already states it exactly, and it is three facts, not one:

> 1. **It cannot be installed.** A box exists because the API called
>    `provider.create()`. There is no registration endpoint in the codebase.
> 2. **It cannot be reached except through a provider.** `resolveIngress()` is
>    mandatory on `SandboxProvider`. `sandbox_provider` is a closed Postgres enum
>    of `daytona | platinum | e2b`. A machine outside those three is not
>    expressible.
> 3. **It supervises exactly one harness.**

Mapped to work:

**(a) Placement can name a machine.** A session's home stops being
`provider.create()` against a closed enum and becomes an assignment to a
registered node. Attempt 1 built this (`compute_nodes`,
`node/assignment-manager.ts`).

**(b) The session's whole data path runs over one outbound socket.** An
arbitrary machine has no ingress — it is behind NAT and we do not own its
network. So chat SSE, file reads, PTY, preview ports and static web all have to
multiplex over the single outbound WebSocket. **This is the expensive part, and
it is where attempt 1 bled**: #6773 (Bun's handshake omits `User-Agent`), #6778
(`permessage-deflate` → `ZlibError`), and most of #6776 (preview ports, PTY
preservation across convergence, reconnect generations, rewriting durable
session URLs) are not incidental bugs. They are the actual work of (b),
discovered in production.

**(c) The session is reproducible, so it can be placed, re-placed and moved.**
Without this, "spawn anywhere" has no recovery story: if the machine dies, the
workspace dies with it.

### (c) is what #6871 just built — the two threads are one thread

Before #6871, hosting a session on a customer's VPS meant shipping Git
credentials to a machine Kortix does not own. The register forbids exactly that:
*a credential boundary cannot depend on a feature flag* (08-22), and *a sandbox
environment carries one credential, not a boot protocol* (08-22).

#6871 replaces the clone with a **content-addressed artifact, verified by
SHA-256 and a manifest marker read without executing it**, fetched with the
session's own token, plus a compiled runtime identity that refuses to boot under
a mismatch (exit 78). That is precisely what makes a workspace materializable on
foreign compute — and re-materializable somewhere else after a failure.

**So the compiler work is not a parallel track. It is a prerequisite for
kortixd,** and the piece that turns "spawn anywhere" into "spawn anywhere and
recover anywhere".

### Why the rest of the recap is not separate work

| Recap item | Status |
| --- | --- |
| Runtime manager (install/version opencode, codex, claude, pi) | **A consequence of line 1.** "Use it for its agent runtime" on a machine we do not image means something must install and pin that runtime. |
| Always up-to-date, self-update, safe rollback | **Forced by line 1.** On a sandbox we can rebuild the image. On a laptop or a customer VPS we cannot, so the binary must update itself. |
| Single API / websocket | **This is line 2.** WS + JSON-RPC 2.0 + Ed25519, already shipped. |
| Full observability (ram/cpu/storage, debugging) | **A consequence of line 2.** Once a 2-way channel exists, telemetry is a stream instead of the one-shot `fetch` POSTs the guest uses today. |
| Lifecycle: shut the node down when nothing is active | **Not a consequence, and must not be built as written — §6.1.** |

---

## The plan, step by step

Every step adds one thing a session running **on a laptop** can do. Ordered by
blast radius: steps 0–6 cannot break a customer session, and step 4 is the
milestone — a real session, hosted on a machine Kortix does not own. The
existing fleet is not touched until step 7, and then only read-only.

| # | Step | Done when | Fleet risk |
| --- | --- | --- | --- |
| 0 | Two measurements, no code | Both numbers written down | none |
| 1 | A machine can exist and be named | A laptop appears in `compute_nodes` and holds an outbound channel | none |
| 2 | The workspace materializes there | `checkout.tar.gz` verified and unpacked on the laptop, no Git credential present | none |
| 3 | The runtime starts there | A pinned OpenCode runs on the laptop and reports healthy through the channel | none |
| 4 | **Chat over the channel** | **A browser turn is answered by the laptop's OpenCode** | none |
| 5 | The rest of the data path | Files, PTY, preview ports and static web all work on that session | none |
| 6 | Self-update, rollback, re-placement | A node updates itself; an unhealthy build rolls back; a killed session resumes on a *different* node | none |
| 7 | Fleet channel: deliver the daemon as an artifact | A pre-existing sandbox downloads, verifies and **runs none of it** | read-only |
| 8 | Sandbox profile: channel present, never started | Golden `/kortix/health` diff is identical | none |
| 9 | Per-box promotion `shadow → prefer → required` | The revert PR's own gate passes on a pre-change box | one box at a time |
| 10 | Harness expansion, then collapse the provider | Spec §11 P3/P4 exits | — |

### Step 0 — Measure (no code)

1. Set `KORTIX_LLM_HOTSWAP=1` on dev. Measure session adoption against the
   6,034 ms OpenCode baseline (§3.1).
2. Query audit rows: what fraction of sessions ever invoke a shell, filesystem
   or PTY tool?

**Why first:** number 1 may delete an entire workstream — if the warm fork
already adopts without a restart, "instant boot" is a flag, not a project.
Number 2 is the only input that makes the Durable Object question answerable
(§6.2). Both are queries, not designs.

### Step 1 — A machine can exist and be named

The registry and the channel, and nothing else. `compute_nodes` with a backfill
so existing provider boxes get rows too — one registry from day one. Enrollment
by device code, reusing agent-tunnel's credential rules (`0600`, owner-checked,
rotatable, node-scoped never account-scoped).

Transport constraints are fixed here, permanently, because they are facts about
Cloudflare rather than about this attempt: explicit `User-Agent` (#6773),
`permessage-deflate` disabled (#6778), close code 4004 retriable and reconnect
generation-safe (#6776).

*Done when:* a laptop appears in the fleet, holds the channel across a network
partition, and reconnects. It hosts nothing yet.

### Step 2 — The workspace materializes there

This is where the compiler work carries kortixd. The node fetches the
content-addressed `checkout.tar.gz` with the session's own token, verifies
SHA-256 and the manifest, and unpacks it. No `git clone`. **No upstream Git
credential ever reaches the machine.**

*Done when:* the laptop holds an exact working tree at a known SHA, and an
`env` dump on that machine contains no credential other than its node token.

### Step 3 — The runtime starts there

The runtime manager: install a pinned harness version, start it, health-check
it, restart it, report its version. `server.mjs` (#6871) already carries the
compiled agent config and refuses to boot under a mismatched identity.

*Done when:* a pinned OpenCode runs on the laptop against the materialized
workspace and reports healthy through the channel.

### Step 4 — Chat over the channel *(the milestone)*

The first surface of the session data path (b). The browser's turn reaches the
laptop's OpenCode and the SSE stream comes back over the same socket.

*Done when:* a chat turn in the browser is answered by OpenCode **running on a
laptop**. At this point a Kortix session is genuinely hosted on a machine
Kortix does not own, and the core claim of the thread is true for the first
time.

### Step 5 — The rest of the data path

Files, find, PTY, port-proxy, web-proxy, static-web — the host services the spec
already calls "shipped, already deployment-agnostic" — all multiplexed over the
one socket. Preview ports must be relayed while credential-helper ports stay
denied; PTYs must survive convergence (both learned the hard way in #6776).

*Done when:* the same laptop session opens a terminal, edits a file, and serves
a preview port in the browser.

### Step 6 — Self-update, rollback, and re-placement

Required, not optional: on a machine we do not image, the binary is the only
thing that can update the binary. Reuse `entrypoint.sh`'s staged swap (exit code
75) and `rollback_agent`, plus #6871's `RuntimeSupervisor` for health-gated
promote and drain.

Then the recovery story (c): kill the node mid-session and let the control plane
re-place that session on a different node, re-materializing the workspace from
the same artifact.

*Done when:* a node self-updates; a deliberately unhealthy build rolls itself
back; and a session survives the loss of the machine it was running on.

### Step 7 — The fleet channel

The first step that touches the sandbox, and only to **deliver**, never to
**run**. A third artifact kind on #6871's channel (§3.2) with its own size cap,
plus shared object storage.

*Done when:* a sandbox created **before** this step downloads and verifies the
kortixd artifact, runs none of it, and behaves identically to a box that did
not — proven by a guest-side probe, never from the API's `/health`.

*Worth shipping alone:* it removes the 2.1 GB image rebuild from the loop for a
96 MB daemon change.

### Steps 8–10

Node core with profiles (§C3), then per-box promotion under the rule in §4, then
harness expansion under §C4. Detail in §5.

### What this ordering changes

Attempt 1 performed steps 7, 8 and 9 in one release and never reached step 4 —
its CLI had no `enroll` and no `connect`, so no machine outside a provider ever
hosted a session. The first machine that exercised the node channel in anger was
the production fleet, and there was no proving ground where a failure cost
nothing.

---

## 0. What attempt 1 actually was

kortixd is specified, built, merged, and reverted.

| Event | Reference | Date |
| --- | --- | --- |
| Spec | `docs/specs/2026-08-21-kortixd.md`, 981 lines | 08-21 |
| Built and merged | PR #6686, +93,917 / −15,893 across 379 files | 08-23 00:52 UTC |
| Nine forward repairs | #6773, #6776, #6778, #6780–#6783, #6786 | same day |
| Emergency revert | #6787, then #6788 | 08-23 14:14 UTC |

It built more of the vision than a glance suggests: `src/node/` carried the
channel client, RPC/socket/stream agents, capabilities (including a CUA driver),
convergence, supervisor, service, policy store and assignment manager; the API
side carried `compute-nodes/` with enroll, device-auth, relay server/socket and
a cluster forwarder. Code survives on `origin/kortixd` and
`origin/compute-node-repair-clean`.

**It diverged from the vision in exactly two ways, and both matter.**

1. **"Spawn it anywhere" was never reachable.** The `kortixd` CLI shipped
   `run | status | update | doctor | version | help`. There is no `enroll` and no
   `connect`. Enrollment existed on the API but only provider bootstrap ever
   called it. No laptop, VPS or EC2 box was ever a node.
2. **The first machine it was pointed at was the production fleet.** The one
   compute Kortix already had working.

So attempt 1 built the hard part and shipped it through the only door that could
hurt. That is the thing to change — not the design.

---

## 1. Post-mortem: one failure class

Every repair addressed the same thing: **a box that already existed could not
become a kortixd node.**

| PR | What broke | Class |
| --- | --- | --- |
| #6773 | Cloudflare refused the WS upgrade; Bun's handshake omits `User-Agent` | edge |
| #6778 | Cloudflare negotiated `permessage-deflate`; daemon looped `ZlibError`, relay 503 | edge |
| #6780 | Daytona had the App hook, not the session hook; legacy boxes woke with no supervisor | legacy fleet |
| #6781 | The baked entrypoint predates self-update; wake timed out after enrollment | legacy fleet |
| #6782 | `setpriv` kept `HOME=/root`; OpenCode could not write its config | legacy fleet |
| #6783 | Concurrent repairs killed the same supervisor and shared one download path | legacy fleet |
| #6786 | Killing the legacy child exited PID 1 and **stopped the VM** | legacy fleet |
| #6776 | Reconnect generation, preview ports, PTY loss, dead callback URLs, orphan reconciliation stopping local worktree sandboxes | mixed |
| — | An empty `/opt/kortix/bootstrap.lock` blocked **every later wake** for that node | legacy fleet |

The cutover was **fail-closed**: the lifecycle waited for a live node channel
before reporting a session active, so a box that could not run the new daemon
stopped being reachable at all — chat, files, PTY and wake together.

The register had the rule nine days earlier:

> **A control split across API and daemon is only live when BOTH halves are**
> (08-14). *"A control that fails OPEN is the right default while it propagates.
> A fail-closed control shipped this way is an outage."*

§14 of the spec named the fleet drain and sized it as *"Land the rename in the
same image bump as P0. Pay it once, as already budgeted."* That is the one line
this document corrects.

---

## 2. Four changes to the design

### C1 — Start where there is no fleet to break

The vision's value is the compute Kortix **cannot** use today: a customer's GPU
box, an EC2 instance, on-prem hardware, a developer laptop, a CI runner. Every
one of those is revenue or moat. The sandbox is compute that already works;
migrating it is cost with no new capability.

Attempt 1 began with the sandbox. Ship a `vps` node first and a total failure
means *"the new thing does not work yet."* Ship the sandbox first and a total
failure means *"every session is down."* Same code, same effort, different first
customer.

**The sandbox is the LAST machine migrated, not the first.**

### C2 — kortixd is agent-tunnel that grew a runtime, not the sandbox daemon that grew a tunnel

`@kortix/agent-tunnel` already ships, in production, on machines Kortix does not
own:

- device-code enrollment, credentials at `0600`, owner-checked, rotatable
- OS service install: LaunchAgent, user systemd, Task Scheduler — starts at
  login, restarts after failure
- WS transport, JSON-RPC 2.0 framing, Ed25519-signed messages, nonce replay
  protection, a per-method authorization hook
- a capability model (`filesystem | shell | desktop`) and a relay in the API

That is most of "kortixd runs anywhere", already built and already surviving
hostile networks. Attempt 1 grew a node channel onto the sandbox daemon
instead. Growing the runtime manager onto the tunnel reaches the same end state
with a failure mode the product already tolerates: **a laptop being offline is
normal; a sandbox daemon failing is an outage.**

### C3 — One binary, two profiles; a sandbox must run with the channel absent

A sandbox and a laptop have opposite constraints:

| | Sandbox | Workstation |
| --- | --- | --- |
| Identity | injected, no enrollment | explicit consent, device code |
| Persistence | wiped between sessions | durable, user-owned |
| Convergence | aggressive, we own the box | conservative, we are a guest |
| Being offline | an incident | the normal case |

Attempt 1 compiled both into one always-on runtime, which is why a defect in the
node channel — a subsystem sandboxes did not need — broke sandboxes.

**A profile decides which subsystems initialize at all.** The sandbox profile
must be able to boot, serve chat, files, PTY and wake with the node channel
compiled in but **never started**. That makes fail-open structural rather than a
flag someone can flip.

### C4 — A harness is a process contract, not a code abstraction

Two reverts share one root cause. 2026-07-30 removed the ACP work (PR #4510,
four harnesses, live matrix 12/12) because *"the refactor did not add a parallel
ACP path, it rewrote shared REST code."* 2026-08-23 removed kortixd after the
daemon extraction met the live fleet. Both tried to make existing code
polymorphic.

The alternative: **kortixd does not abstract harnesses at all.** It installs a
pinned binary, starts it, health-checks it, and exposes its port or stdio over
the node channel. OpenCode speaks REST on a port. Claude Code and Codex speak
ACP on stdio. Adding a harness is a manifest row plus one adapter file, with
**zero edits to any existing harness path**.

This satisfies the spec's §12 July rule — *no PR may modify a line inside
`opencode*.ts`* — by construction instead of by review discipline. And it places
ACP correctly: ACP is **one adapter**, not the node's contract. The node's
contract is "supervise a process, expose its socket".

---

## 3. Two things already built that answer the thread's goals

### 3.1 The boot-speed goal is a flag, not a project — measure it first

#6871 removed `git clone` from boot and measured what remained:

| Stage | Time |
| --- | ---: |
| Compiled checkout materialization | 700 ms |
| Remaining daemon setup | 376 ms |
| **OpenCode spawn to ready** | **6,034 ms** |

OpenCode is **84%** of a 7,143 ms in-guest boot. Compiling `kortix.yaml` into a
bundle cannot touch that — compile the config to zero bytes and the number
barely moves. The only thing that removes a per-session cost is not paying it
per session.

**That mechanism already exists and is switched off.**
`apps/kortix-sandbox-agent-server/src/main.ts:942` carries the *"Warm-fork
NO-RESTART path"* — a stateful warm fork that adopts a session **without an
OpenCode restart** — behind `KORTIX_LLM_HOTSWAP=1`. That variable is set in
zero environments: not `.env`, not `.env.dev`, not `infra/`, not
`apps/sandbox/`.

**Do this before designing anything.** Enable it on dev, measure adoption
latency against the 6,034 ms baseline, and report the number. If it holds, the
headline boot goal is a flag flip. If it does not, we learn why before building
kortixd around residency.

### 3.2 #6871 built the cutover primitive kortixd needed

While removing `git clone`, #6871 built content-addressed artifacts verified in
the guest by SHA-256 plus a manifest marker read **without executing** the
artifact, a download-and-adopt path that needs **no image rebuild**
(`install-compiled-runtime`, with entrypoint fallback on exit 78/127), and the
ladder `off | shadow | prefer | required`.

`shadow` is exactly the state kortixd needed and did not have: *download it,
verify it, prove it, use none of it.*

Two gaps before that channel can carry a daemon:

- **Size.** The compiled-runtime cap is 16 MiB; `dist/kortixd` is 95,692,928
  bytes. The checkout cap is 512 MiB, so the shape works and the constant does
  not.
- **Storage.** The artifact cache is per-API-replica `/tmp`. Shared object
  storage is a prerequisite for a fleet-wide daemon channel.

---

## 4. The rule that replaces "pay it once"

> **A box does not become a kortixd node until kortixd has run on that exact box,
> in `shadow`, beside the incumbent runtime, for one complete session.
> `required` is a per-box row in the database, never a global flag.**

Consequences that may not be traded away:

- The incumbent runtime serves chat, files, PTY and wake for the whole
  migration. kortixd earns each box; it is never granted the fleet.
- A box that cannot run kortixd stays on the incumbent path forever, with no
  user-visible effect. It is a telemetry row, not an incident.
- No API path may require a node channel to consider a session active until that
  box's own row says `required`.
- No lock may make a failure permanent. Every bootstrap lock records boot id and
  owner PID and self-heals when empty or stale — the specific defect that turned
  #6686 into an outage.

---

## 5. Phases, ordered by risk to the existing fleet

The spec's P0–P4 content stands. The order changes.

### P-1 — Measure (days, no code)

1. Enable `KORTIX_LLM_HOTSWAP=1` on dev; measure session adoption against the
   6,034 ms baseline.
2. Query audit rows for the fraction of sessions that ever invoke shell,
   filesystem or PTY tools. **This is the only input that makes the Durable
   Object question answerable** (§6.2), and it is a query, not a design.

*Exit:* both numbers written down.

### P0 — A VPS is a node (no sandbox involved)

`kortixd enroll` and `kortixd connect` as real commands. Workstation profile
only. Node channel, capabilities, convergence — all against a machine no
customer session depends on.

*Exit:* an EC2 instance or a laptop runs one full session through
`dev.kortix.com`, with the network-partition case exercised live. **Nothing in
the sandbox path changed.**

### P1 — The fleet channel

Daemon delivery as a verified artifact (§3.2): a third artifact kind with its
own cap, plus shared object storage. `shadow` semantics for the daemon.

*Exit:* a sandbox created **before** this phase downloads, verifies and reports
a kortixd artifact while running none of it, and behaves identically to a box
that did not. Proven by a guest-side probe on a real pre-existing dev box — per
*"A deployed API is not a deployed daemon"* — never from the API's `/health`.

*Worth shipping alone:* it removes the 2.1 GB image rebuild from the loop for a
96 MB daemon change.

### P2 — Node core and profiles

The spec's P0, plus C3: the sandbox profile boots with the channel never
started.

*Exit:* golden characterization diff identical; swap-handshake 9/9; one
pre-existing box reports the new artifact while still running the old runtime.

### P3 — Session manager

The spec's P1, unchanged. `compute_nodes`, claim/release/clean.

*Exit:* one node runs session A, releases, cleans, runs session B, with the
adversarial isolation probe passing.

### P4 — The sandbox becomes a node *(the phase that failed)*

Per box, gated on that box's own `shadow` result.

Permanent transport constraints, paid for on 08-23:

- Send an explicit `User-Agent`; Bun's native WS handshake omits it and
  Cloudflare refuses the upgrade (#6773).
- Disable `permessage-deflate` (#6778).
- Treat close code 4004 as retriable; make reconnect generation-safe (#6776).

*Exit:* the gate the revert PR already wrote — **one pre-change session passes
browser chat, files, PTY, idle survival, and stop/start recovery** — on a box
created before the phase, with the incumbent path still installed and reachable.

### P5 — Harness expansion, then collapse the provider

The spec's P3 and P4, with C4: adapters are added beside, never inside.

---

## 6. The recap, answered

| # | Ask | Answer |
| --- | --- | --- |
| 1 | Single binary, any compute | Right, and mostly built. Change the first target (C1) and add profiles (C3). |
| 2 | Relay to kortix-api, 2-way | Right. Build it **from** agent-tunnel (C2), not beside it. |
| 3 | Runtime manager, standard versions | Right. Convergence shipped 08-20 (#6673, #6676). |
| 4 | Self-update, safe rollback | **Highest value.** Answers *"a deployed API is not a deployed daemon"*. `entrypoint.sh` has restart + swap code 75 + rollback; #6871's `RuntimeSupervisor` adds health-gated promote, atomic swap and drain. |
| 5 | Single API / websocket | Right. Spec §5.4. |
| 6 | Shut the node down when nothing is active | **Refuse as written — §6.1.** |
| 7 | Full observability | Right, and genuinely new: today the guest talks out only through one-shot `fetch` POSTs. There is no persistent bidirectional socket from a sandbox. |
| 8 | Orchestrate durable object vs native compute | **Partially refuse — §6.2.** |
| 9 | "If the sandbox crashed, put it online again" | **Split it — §6.3.** |
| 10 | kortix.yaml → compiled bundle, instant boot | Right, and already 71% delivered by #6871 — but it cannot touch the remaining 84%. See §3.1. |

### 6.1 kortixd must never decide its own box should stop

This mechanism existed and was deleted on 2026-07-29. From `box-reaper.ts`: an
in-guest lease renewed every 60 s, a busy probe, and an activity clock —
*"three mechanisms, all fed by the subject of the judgement."*

> Measured live: 187 genuinely running prod boxes, 156 of which had never
> emitted a single LLM usage event, the oldest 264 hours old;
> `metadata.idleObservedAt` was null on 100% of active rows, meaning the
> idle-stop path had never fired in production, not once.

An externally-owned deadline replaced all three.

**Safe restatement:** kortixd **reports** evidence — process state, RSS, CPU,
disk, port bindings, exact active-turn observations. The control plane
**decides** the deadline. A node never stops itself and never renews its own
life.

Binding rules: *A sandbox lifecycle grant requires exact active-turn evidence*
(08-17); *Active-turn renewal cadence must stay below the shortest provider
backstop* (08-17); *Every sandbox stop must revoke all persisted turn authority*
(08-17); *Transcript shape alone may never end a turn* (08-20); *Every
runtime-initiated turn must be announced to the control plane* (08-20).

### 6.2 Durable Objects cannot host an agent's machine

A Durable Object is a stateful V8 isolate: no `fork`/`exec`, no PTY, no full
filesystem, no CUA. kortixd's capability set — `shell`, `filesystem`, `desktop`
— is not satisfiable there.

What is true: a DO can host the session and orchestration layer, where boot
latency and cost matter and no process is spawned.

So the question is not "DO or microVM per session". It is **"which capability
set does this session need?"** — and P-1 answers it with a query. If most
sessions never touch shell, a cheap lane is a real cost lever; if most do, it is
noise. The ≈$2,500-for-32-concurrent figure from the thread is recorded as a
claim from that thread, unverified here.

### 6.3 "Restart the crashed sandbox" is three layers and two owners

| Layer | Failure | Owner | Status |
| --- | --- | --- | --- |
| 0 | The runtime process died | **kortixd**, in-guest | Exists in bash: restart loop, early-exit counter, rollback |
| 1 | The box or VM died | **Control plane only** | Exists: reaper, `runtime-wake-fence`, `stuck-sessions`, prompt requeue |
| 2 | Where the replacement goes | Control plane scheduler | Spec §7.6 |

**kortixd cannot perform Layer 1.** If the VM dies the daemon dies with it. What
kortixd changes is **detection latency**: a dropped socket is immediate; the
reaper is a sweep.

Two constraints on Layer 1 work:

- **Fence it.** *Fence every detached lifecycle mutation with a durable
  operation id* (08-22) — one DB claim per `session_id`. One session already
  accepted three restarts in 27 s and oscillated `running → provisioning →
  stopped → running → stopped`.
- **Carry identity forward.** #6871 compiles runtime identity into `server.mjs`
  and exits 78 on mismatch, so a resurrected box must receive the same artifact
  or refuse to boot. That makes resurrection verifiable, and means the
  resurrection path must carry artifact identity, not only a session id.

---

## 7. Constraints inherited from the register

| Rule | Date | Bearing |
| --- | --- | --- |
| A deployed API is not a deployed daemon | 08-12 | Prove every daemon change in the guest, by artifact content |
| A control split across API and daemon is only live when both are | 08-14 | Fail **open** for the whole migration |
| A sandbox environment carries one credential, not a boot protocol | 08-22 | Inject only `KORTIX_TOKEN`; the node claims the rest |
| A credential boundary cannot depend on a feature flag | 08-22 | No enrollment mode may return upstream credentials to a guest |
| A relay that authenticates with the wrong credential fails silently, forever | 08-20 | Sandbox-identity relays use `KORTIX_SANDBOX_TOKEN \|\| KORTIX_TOKEN`; assert the header, not the call count |
| Two dev stacks on one shared DB share one work queue | 08-22 | `KORTIX_INSTANCE_ID` scoping already exists; enrollment must respect it |
| Keep the legacy relay until old sessions pass a real cutover gate | 08-23 | §4 and the P4 exit criterion |

---

## 8. Decisions needed from a human

1. **Does C1 stand?** Shipping a VPS node before touching the sandbox is the
   single largest change here. It delays the sandbox migration and delivers new
   capability first. Recommend yes.
2. **Resume or re-land?** `compute-node-repair-clean` carries all nine repairs
   plus the fleet-migration debt. Recommend re-landing behind P1 and
   cherry-picking only #6773 and #6778 — those are facts about Cloudflare, not
   about this attempt.
3. **Does P1 block on shared object storage?** The cache is per-replica `/tmp`
   today; without shared storage one replica's cache decides whether a box can
   converge.
4. **Who owns the harness question?** C4 makes adapters additive, but whether a
   first-party `kortix` harness exists at all is a product decision (spec §15.3)
   and is where the Flu / Eve / Pi discussion belongs.
5. **Metering for self-registered nodes** — spec §10.3, still open.

---

## 9. What this document does not change

The spec's §1–§10 and §12–§15 stand. §12's July rule remains the review gate;
C4 makes it structural rather than procedural. The 07-30 and 08-23 rollbacks had
different causes — a seam that leaked into shared code, and a cutover that
needed a fleet it could not reach. Both guards are required.
