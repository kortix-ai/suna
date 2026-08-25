# kortixd v2 — the rollout, not the design

Status: **PROPOSED**. Date: 2026-08-25.
Amends `docs/specs/2026-08-21-kortixd.md`. That spec stays authoritative for
**what** kortixd is. This document replaces its §11 phases and §14 fleet risk
with **how it reaches a live fleet without taking one down again.**

---

## 0. Read this first

kortixd is not a new idea in this repository. It is specified, built, merged,
and reverted.

| Event | Reference | Date |
| --- | --- | --- |
| Spec written | `docs/specs/2026-08-21-kortixd.md`, 981 lines | 2026-08-21 |
| Built and merged | PR #6686, +93,917 / −15,893 across 379 files | 2026-08-23 00:52 UTC |
| Nine forward repairs | #6773, #6776, #6778, #6780–#6783, #6786 | same day |
| Emergency revert | PR #6787, then #6788 | 2026-08-23 14:14 UTC |
| Schema removed forward-only | `20260823204922383_drop_compute_node_tables` | 2026-08-23 |

The code survives on `origin/kortixd` (`e391f4e76d`) and
`origin/compute-node-repair-clean` (`7f6b2ee4a9`, carrying all nine repairs).
Nothing needs to be rewritten from scratch.

**The design was not the failure. The cutover was.** Do not start by editing
the spec.

---

## 1. Post-mortem: one failure class, not nine bugs

Every repair PR merged on 2026-08-23 addressed the same thing — **a box that
already existed could not become a kortixd node.**

| PR | What broke | Class |
| --- | --- | --- |
| #6773 | Cloudflare refused the WS upgrade; Bun's native handshake omits `User-Agent` | edge |
| #6778 | Cloudflare negotiated `permessage-deflate`; daemon looped `Decompression error: ZlibError`, relay 503 | edge |
| #6780 | Daytona implemented the App hook but not the session hook; legacy boxes resumed with no supervisor | legacy fleet |
| #6781 | The baked entrypoint predates self-update, so wake timed out after enrollment | legacy fleet |
| #6782 | `setpriv` kept `HOME=/root`; OpenCode could not write its config | legacy fleet |
| #6783 | Concurrent repairs killed the same supervisor and shared one download path | legacy fleet |
| #6786 | Killing the legacy child exited PID 1 and **stopped the VM** | legacy fleet |
| #6776 | Reconnect generation, preview ports, PTY loss on convergence, dead callback URLs, orphan reconciliation stopping local worktree sandboxes | mixed |
| — | An empty `/opt/kortix/bootstrap.lock` blocked **every later wake** for that node | legacy fleet |

Two edge defects. Six fleet-migration defects. One lock that turned a transient
failure into a permanent one.

### 1.1 The mechanism

The cutover was **fail-closed**. The lifecycle began waiting for a live node
channel before it would report a session active (#6776). A box that could not
run the new daemon therefore stopped being reachable at all — chat, files, PTY,
and wake together.

The register had already written the rule, nine days earlier:

> **A control split across API and daemon is only live when BOTH halves are**
> (2026-08-14). The API half goes live when Deploy Dev finishes. The daemon half
> is baked into the sandbox image and reaches a guest only through a new
> snapshot build. *"A control that fails OPEN is the right default while it
> propagates. A fail-closed control shipped this way is an outage."*

And the sibling rule names the verification that was skipped:

> **A deployed API is not a deployed daemon** (2026-08-12). Prove it in the
> guest, not from the API.

### 1.2 Why the spec did not prevent it

§14 of the spec lists the risk and mis-sizes the mitigation:

> *The fleet drain — the supervisor only reaches a box on re-provision* →
> *"Land the rename in the same image bump as P0. Pay it once, as already
> budgeted."*

That treats a live-fleet migration as a one-time cost. It is the hardest
engineering problem in the project, and it is the only one that can take
production down. This document exists to correct that single line.

---

## 2. What changed since: #6871 supplies the missing primitive

PR #6871 (`codex/compiled-boot`, draft) was written to remove `git clone` from
session boot. It also, incidentally, built **the exact delivery mechanism a
fleet migration needs**:

1. **Content-addressed artifacts** keyed by `(format, project, ref, source_sha)`,
   verified in the guest by SHA-256 **plus** a manifest marker that is read
   without executing the artifact.
2. **A four-state rollout ladder** — `off | shadow | prefer | required` —
   applied per boot through `KORTIX_COMPILED_BOOT_MODE`.
3. **A verified download-and-adopt path in the guest** that needs no image
   rebuild: `kortix-agent install-compiled-runtime` returns a path the
   entrypoint executes, and falls back to the baked binary on exit code 78/127.
4. **Immutable runtime identity**, compiled into `server.mjs`, which exits 78
   rather than boot under a mismatched identity.

`shadow` is the state kortixd needed and did not have: *download it, verify it,
prove it, and use none of it.*

Measured in that PR: repository materialization fell from 2,916 ms to 845 ms
warm, and OpenCode spawn is now 84% of a 7,143 ms in-guest boot.

### 2.1 Two honest gaps before this channel can carry a daemon

- **Size.** The compiled-runtime cap is 16 MiB. `dist/kortixd` is 95,692,928
  bytes. The checkout cap is 512 MiB, so the shape works and the constant does
  not. A daemon channel needs its own artifact kind and its own cap.
- **Storage.** The artifact cache is local ephemeral storage on one API
  replica (`/tmp/kortix/compiled-boot`). For a fleet-wide daemon channel,
  shared object storage is a **prerequisite**, not a follow-up.

---

## 3. The one structural change

> **A box does not become a kortixd node until kortixd has run on that exact box,
> in `shadow`, beside the incumbent runtime, and reported a matching golden
> health for one complete session.**
>
> **`required` is a per-box state in the database. It is never a global flag.**

Everything below follows from that sentence.

Consequences, stated so they cannot be traded away later:

- The incumbent runtime keeps serving chat, files, PTY, and wake for the whole
  migration. kortixd earns each box; it is never granted the fleet.
- A box that cannot run kortixd stays on the incumbent path **forever**, with no
  user-visible effect. It is a telemetry row, not an incident.
- Nothing in the API may require a node channel to consider a session active
  until that box's own row says `required`.
- No lock may make a failure permanent. Every bootstrap lock records boot id and
  owner PID and self-heals when empty or stale — the specific defect that turned
  #6686 from a bad day into an outage.

---

## 4. Revised phases

The spec's P0–P4 keep their numbering and content. Two changes: a new phase in
front, and a different exit criterion on each.

### P-1 — The fleet channel *(new; blocks everything else)*

Ship daemon delivery as a verified artifact, so a daemon change reaches a
running box without an image rebuild.

- A third artifact kind beside `checkout.tar.gz` and `server.mjs`, with its own
  size cap, served through the same authenticated route and verified the same
  way.
- Shared object storage for the artifact cache (§2.1).
- `shadow` semantics for the daemon: download, verify, report, run nothing.

*Exit:* a sandbox created **before** this phase downloads, verifies, and reports
a kortixd artifact, and its behavior is byte-identical to a box that did not.
Proven by a guest-side probe on a real pre-existing dev box, per
*"A deployed API is not a deployed daemon"* — not from the API's `/health`.

*Worth on its own, even if kortixd never lands:* it removes the 2.1 GB image
rebuild from the loop for a 96 MB daemon change.

### P0 — Node core + standalone daemon

Unchanged from the spec, plus: the rename lands as a `shadow` artifact, not as
an image bump.

*Exit:* as specified (golden characterization diff, swap-handshake 9/9), **and**
one pre-existing box reports the new artifact while still running the old
runtime.

### P1 — Session manager

Unchanged.

*Exit:* as specified, plus the adversarial isolation probe.

### P2 — Sandbox channel *(the phase that failed)*

The outbound channel, per box, gated on that box's own `shadow` result.

Permanent transport constraints, paid for on 2026-08-23:

- Send an explicit `User-Agent` on the node channel. Bun's native WebSocket
  handshake omits it and Cloudflare refuses the upgrade (#6773).
- Disable `permessage-deflate` on the node channel (#6778).
- Treat replacement close code 4004 as retriable; make reconnect
  generation-safe (#6776).

*Exit:* the follow-up gate the revert PR already wrote — **one pre-change
session passes browser chat, files, PTY, idle survival, and stop/start
recovery** — run on a box that was created before the phase, with the incumbent
path still installed and reachable.

### P3 / P4

Unchanged from the spec.

---

## 5. Marko's recap, answered item by item

Seven of nine are already built or straightforward. Two must be refused as
written.

| # | Ask | Answer |
| --- | --- | --- |
| 1 | Single binary, any compute | **Built.** `dist/kortixd`, 95,692,928-byte Linux ELF, on `origin/kortixd`. |
| 2 | Connects to kortix-api as relay, 2-way | **Built, in the wrong place.** `@kortix/agent-tunnel` is WS + JSON-RPC 2.0 + Ed25519-signed + nonce replay guard + a capability model. It points at laptops, not sandboxes. Reuse it; do not design a second protocol. |
| 3 | Runtime manager, standard versions | **Built.** Convergence + staged swap + immutable floor, dev-verified 2026-08-20 (#6673, #6676). |
| 4 | Self-update, safe rollback | **Highest-value item.** `entrypoint.sh` has the restart loop, swap code 75, and `rollback_agent`. #6871's `RuntimeSupervisor` prototype adds health-gated promote, atomic route swap, drain, and rollback. This is the direct answer to *"A deployed API is not a deployed daemon"*. |
| 5 | Single API / websocket | Yes — §5.4 of the spec. |
| 6 | **Lifecycle: shut the node down when nothing is active** | **Refuse as written. See §6.** |
| 7 | Full observability: ram/cpu/storage/debugging | Yes, and the clearest genuine win. Today the guest talks out through one-shot `fetch` POSTs (boot timeline, audit relay); there is **no persistent bidirectional socket from a sandbox**. A node channel makes this a stream instead of an inference. |
| 8 | Orchestrate durable object vs native compute | **Partially refuse. See §7.** |
| 9 | "If the sandbox crashed, put it online again" | **Split it or it double-provisions. See §8.** |

---

## 6. Why kortixd must not decide its own box should stop

This is the one item that must not be built the way it is written.

**It already existed and was deleted.** Until 2026-07-29 a running box was
judged by asking the box: an execution lease the in-sandbox agent renewed every
60 s while its local OpenCode believed any session was `busy` or `retry`, then a
busy probe against that same daemon, plus an activity clock the lease renewal
stamped. From `box-reaper.ts`:

> Three mechanisms, all fed by **the subject of the judgement**. Measured live:
> 187 genuinely running prod boxes, 156 of which had never emitted a single LLM
> usage event, the oldest 264 hours old; `metadata.idleObservedAt` was null on
> 100% of active rows, meaning the idle-stop path had never fired in production,
> not once.

Deleting all three was the fix. An externally-owned deadline replaced them.

**The restatement that is safe to build:**

> kortixd **reports** evidence — process state, RSS, CPU, disk, port bindings,
> exact active-turn observations. The control plane **decides** the deadline.
> A node never stops itself and never renews its own life.

Related rules that bind this surface:

- *A sandbox lifecycle grant requires exact active-turn evidence* (2026-08-17).
- *Active-turn renewal cadence must stay below the shortest provider backstop*
  (2026-08-17) — 30 s cap, leader-owned loop.
- *Every sandbox stop must revoke all persisted turn authority* (2026-08-17).
- *Transcript shape alone may never end a turn* (2026-08-20).
- *Every runtime-initiated turn must be announced to the control plane*
  (2026-08-20) — OpenCode starts turns nobody delivered.

---

## 7. Durable Objects cannot host an agent's machine

A Durable Object is a stateful V8 isolate. It has no `fork`/`exec`, no PTY, no
full filesystem, and no CUA surface. kortixd's declared capability set —
`shell`, `filesystem`, `desktop` — is **not satisfiable there**.

What is true: a DO can host the session and orchestration layer, where boot
latency and cost matter and no process is spawned.

So the orchestration question is not "DO or microVM per session". It is:

> **Which capability set does this session need?** A session that only calls
> models and connectors needs no machine. A session that runs a shell needs one.

Answer that first, then place it. The cost figure quoted in the thread
(≈$2,500 for 32 concurrent sandboxes) is recorded here as a claim from that
thread; it is not verified in this document.

---

## 8. "Restart the crashed sandbox" — three layers, two owners

Conflating these is the fastest route to double-provisioning and double-billing.

| Layer | Failure | Owner | Status |
| --- | --- | --- | --- |
| 0 | The runtime process died | **kortixd**, in-guest | Exists in bash: restart loop, early-exit counter, rollback |
| 1 | The box or VM died | **Control plane only** | Exists: reaper sweep, `runtime-wake-fence`, `stuck-sessions`, prompt requeue |
| 2 | Where should the replacement go | Control plane scheduler | Spec §7.6 |

**kortixd cannot perform Layer 1.** If the VM dies, the daemon dies with it.
What kortixd changes is **detection latency**: a dropped socket is an immediate
signal; the reaper is a sweep.

Two constraints on any Layer 1 work:

- **Fence it.** *Fence every detached lifecycle mutation with a durable
  operation id* (2026-08-22) — one DB claim per `session_id`, every provider
  step predicated on that claim. One session already accepted three restarts in
  27 seconds and oscillated `running → provisioning → stopped → running →
  stopped`.
- **Carry identity forward.** #6871 compiles runtime identity into `server.mjs`
  and exits 78 on mismatch. A resurrected box must receive the same artifact or
  it refuses to boot. That is a feature — resurrection becomes verifiable — but
  the resurrection path must carry artifact identity, not just session id.

---

## 9. Constraints inherited from the register

Every phase is bound by these. They are not advisory.

| Rule | Date | Bearing on kortixd |
| --- | --- | --- |
| A deployed API is not a deployed daemon | 08-12 | Prove every daemon change in the guest, by artifact content |
| A control split across API and daemon is only live when both are | 08-14 | Fail **open** for the whole migration |
| A sandbox environment carries one credential, not a boot protocol | 08-22 | Inject only `KORTIX_TOKEN`; the node claims everything else |
| A credential boundary cannot depend on a feature flag | 08-22 | No enrollment mode may restore upstream credentials to a guest |
| A relay that authenticates with the wrong credential fails silently, forever | 08-20 | Sandbox-identity relays resolve `KORTIX_SANDBOX_TOKEN \|\| KORTIX_TOKEN`; test the wire, assert the header |
| Two dev stacks on one shared DB share one work queue | 08-22 | `KORTIX_INSTANCE_ID` scoping already exists; node enrollment must respect it |
| Keep the legacy relay until old sessions pass a real cutover gate | 08-23 | §3, and the P2 exit criterion |
| Give reviewed infrastructure rollbacks an explicit delete path | 08-23 | Written *by* the kortixd rollback |

---

## 10. Decisions needed from a human

1. **Resume or re-land?** `compute-node-repair-clean` already carries all nine
   repairs. Resuming keeps the fixes and the fleet-migration debt; re-landing P0
   clean from `kortixd` behind P-1 discards both. Recommend: re-land behind
   P-1, and cherry-pick the two transport fixes (#6773, #6778) as permanent
   contract, since they are facts about Cloudflare and not about this attempt.
2. **Does P-1 block on shared object storage?** The artifact cache is
   per-replica `/tmp` today. A fleet-wide daemon channel without it means one
   replica's cache decides whether a box can converge.
3. **What actually kills the 6.0 s OpenCode spawn?** #6871 removed Git from the
   critical path; OpenCode is now 84% of in-guest boot. Neither compiled boot
   nor kortixd makes that faster. Only a **resident** runtime does — which is
   the strongest latency argument for a daemon, and needs its own measurement
   before it is promised.
4. **Metering for self-registered nodes** — spec §10.3, still open.

---

## 11. What this document does not change

The spec's §1–§10 and §12–§15 stand. In particular §12's July rule — *no pull
request in P0–P2 may modify a line inside `opencode*.ts`* — remains the review
gate. The 2026-07-30 rollback and the 2026-08-23 rollback have different causes:
the first was a seam that leaked into shared code, the second was a cutover that
required a fleet it could not reach. Both guards are needed.
