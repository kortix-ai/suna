# kortixd requirements and verification contract

Status: normative.  
Architecture rationale: `docs/specs/2026-08-21-kortixd.md`.  
The terms MUST, MUST NOT, SHOULD, and MAY are normative.

The first deployment target is a provider-created sandbox compute node. The
protocol and daemon are compute-type neutral. Filesystem, shell, desktop,
device enrollment, OS services, and the compatibility migration from
`@kortix/agent-tunnel` are part of the complete target. The existing tunnel
remains operational until `kortixd` passes every parity and migration gate.
New capability code MUST live in `kortixd`. It MUST NOT depend on the old
agent-tunnel runtime.

## 1. Product boundary

- `KXD-001` `kortix` and `kortixd` MUST remain separate executables.
- `KXD-002` `kortix` MUST own user login, installation, enrollment initiation,
  and remote node-management commands.
- `KXD-003` `kortixd` MUST own node identity, the API channel, workloads,
  capabilities, managed runtimes, convergence, health, and recovery.
- `KXD-004` The release MUST contain one daemon artifact named `kortixd`. It
  MUST NOT publish a second `kortix-agent` artifact.
- `KXD-005` A compute node MUST require only `kortixd` plus an enrollment
  credential. Provider SDKs and the Kortix SDK MUST NOT run on the node.
- `KXD-006` The sandbox node protocol MUST remain compute-type neutral. A future
  VM, bare-metal, workstation, or CI implementation can implement it unchanged.
- `KXD-007` Provider-specific code MUST stop after allocation lifecycle and
  initial `kortixd` installation.

## 2. Compute-node identity and lifecycle

- `KXD-010` The API MUST assign one immutable `compute_node_id` to each node.
- `KXD-011` The node record MUST state type, provider, allocation ID,
  architecture, operating system, daemon version, update channel, status,
  capabilities, harnesses, concurrency, last heartbeat, and desired manifest.
- `KXD-012` The API MUST expose create, list, get, update, rotate-credential,
  enable, disable, drain, restart, and delete operations.
- `KXD-013` Every operation MUST enforce account and project authorization.
- `KXD-014` Device authorization MUST enroll an interactive computer without
  printing a durable credential in browser or terminal output.
- `KXD-015` Automated enrollment MUST accept a short-lived single-use token.
- `KXD-016` The node credential MUST identify only one node. It MUST NOT act as
  a user, account, project, or sandbox credential.
- `KXD-017` Credential rotation MUST terminate the old channel. The old
  credential MUST fail every subsequent handshake.
- `KXD-018` Deleting a node MUST revoke its credential, close its channel,
  release assignments, and preserve audit records.
- `KXD-019` A disabled or draining node MUST receive no new assignment.
- `KXD-020` A draining node MUST finish or explicitly stop its current workload.
- `KXD-021` Installing and enrolling `kortixd` on a local computer MUST
  create the same compute-node record and channel as a provider-created machine.
- `KXD-022` Current scheduling cardinality MUST be one session to one compute
  node. A session MUST NOT span multiple compute nodes in this release.
- `KXD-023` The assignment schema MUST permit a future session-to-many-nodes
  scheduler without changing node identity or the node channel protocol.

## 3. One outbound connection

- `KXD-030` `kortixd` MUST establish an outbound authenticated channel to the
  Kortix API. The API MUST NOT require inbound access to the node.
- `KXD-031` Normal session traffic MUST NOT use Daytona, Platinum, E2B, Docker,
  Kubernetes, SSH, or direct-IP ingress.
- `KXD-032` The channel MUST use TLS outside loopback development.
- `KXD-033` The credential MUST travel in the first channel message. It MUST NOT
  appear in URLs, query strings, logs, health responses, or process arguments.
- `KXD-034` Every post-authentication message MUST have an HMAC signature and a
  strictly increasing nonce.
- `KXD-035` The receiver MUST reject unsigned, replayed, malformed, oversized,
  out-of-order, or capability-invalid messages.
- `KXD-036` A second channel for the same node MUST deterministically replace
  the first. The displaced process MUST stop reconnecting.
- `KXD-037` Heartbeats MUST update node liveness and registered capabilities.
- `KXD-038` Cross-instance API forwarding MUST route to the API instance that
  owns the live node socket.
- `KXD-039` Disconnect MUST abort all live streams and mark the node offline.
- `KXD-040` Reconnect MUST use bounded exponential backoff with jitter.

## 4. Streaming relay

- `KXD-050` The node channel MUST carry HTTP request and response streams.
- `KXD-051` The relay MUST preserve method, path, query, allowed headers,
  response status, allowed response headers, and byte order.
- `KXD-052` The relay MUST support incremental SSE without buffering the full
  response.
- `KXD-053` The relay MUST support WebSocket upgrade and bidirectional frames.
- `KXD-054` The relay MUST support request and response bodies larger than one
  channel frame.
- `KXD-055` Per-stream flow-control windows MUST bound memory at both ends.
- `KXD-056` Cancellation from either end MUST abort local sockets, release
  buffers, and produce one terminal stream event.
- `KXD-057` Stream IDs and sequence numbers MUST prevent cross-stream data bleed.
- `KXD-058` A disconnect MUST NOT replay a partial non-idempotent request.
- `KXD-059` The compatibility `/p/:externalId/:port/*` route MUST resolve the
  node and use the same channel. It MUST NOT call provider ingress.
- `KXD-060` New API code SHOULD address `compute_node_id` directly.
- `KXD-061` The channel MUST be full duplex. Either endpoint MUST be able to
  initiate a control message while other streams remain active.
- `KXD-062` `kortixd` MUST expose an authorized local port through the channel
  without requiring application-specific relay code. OpenCode REST is one
  consumer of this generic port relay.
- `KXD-063` A port relay MUST bind only to loopback from `kortixd`. The API MUST
  authorize node, assignment, port, method, and caller before opening it.
- `KXD-064` Arbitrary local ports MUST be denied by default. Assignment policy
  and the node's local ceiling MUST both permit the port.

## 5. Workloads and sessions

- `KXD-070` A node MUST advertise its workload kinds and available concurrency.
- `KXD-071` Session assignment MUST be lease-based, idempotent, and tied to one
  immutable `session_id`.
- `KXD-072` A session workload MUST validate identity, repository, branch,
  secrets revision, harness, ports, and writable paths before readiness.
- `KXD-073` The node MUST clone or refresh only the assigned repository and
  session branch.
- `KXD-074` The node MUST start the selected harness and report its native
  conversation identity.
- `KXD-075` The API MUST mark the session ready only after the harness health
  endpoint answers through the node channel.
- `KXD-076` Stop MUST end the live turn, stop the harness, and keep the workspace
  when the product operation is resumable.
- `KXD-077` Restart MUST preserve the branch and workspace, rotate scoped
  credentials, and recreate a healthy harness.
- `KXD-078` Release MUST remove session credentials and return the node to a
  clean reusable state.
- `KXD-079` Two sequential sessions on one node MUST not share credentials,
  OpenCode state, messages, environment, or uncommitted files.
- `KXD-080` A running session MUST survive a temporary API outage. New work MUST
  wait until the channel returns.
- `KXD-081` The API MUST bind one active session assignment to exactly one
  compute node and one lease epoch. A second node MUST not accept that lease.

## 6. Harnesses and capabilities

- `KXD-090` OpenCode MUST be the first harness adapter and retain its REST
  behavior.
- `KXD-091` Harness discovery MUST report binary path, version, health, and
  management ownership.
- `KXD-092` Future Claude Code, Codex, and other harnesses MUST enter through the
  same adapter registry. They MUST NOT add provider branches.
- `KXD-093` Filesystem, shell, desktop, and ports MUST be capability adapters in
  `kortixd`.
- `KXD-094` The existing computer-agent tunnel filesystem, shell, desktop,
  permission, device-auth, credential, and service behavior MUST move into
  `kortixd` before the old executable is retired.
- `KXD-095` The local permission ceiling MUST always win. API permissions MAY
  narrow it and MUST NOT widen it.
- `KXD-096` Filesystem access MUST enforce allowed roots, blocked paths, file
  sizes, symlink safety, and traversal rejection.
- `KXD-097` Shell access MUST enforce command rules, environment allowlists,
  timeout ceilings, output ceilings, and cancellation.
- `KXD-098` Desktop access MUST require an explicitly installed trusted driver.
  `kortixd` MUST NOT silently download or execute one.
- `KXD-099` Every remote capability operation MUST write an audit event without
  secret values or file contents.

## 7. Desired-state convergence

- `KXD-110` The API runtime manifest MUST be the desired state for its node
  fleet. “Latest” means the version and digest selected by that manifest, not
  an unpinned upstream release.
- `KXD-111` The manifest MUST identify `kortixd`, `kortix`, OpenCode, managed
  skills, harness support files, and every future managed binary independently.
- `KXD-112` Each managed component MUST carry a version, SHA-256 digest, size,
  download path, update policy, and compatibility metadata.
- `KXD-113` `kortixd` MUST reconcile at boot, assignment, resume, explicit
  update, and a bounded periodic interval.
- `KXD-114` A node MUST compare bytes or an authenticated digest. Version text
  alone MUST NOT prove convergence.
- `KXD-115` A node MUST never move below its recorded manifest epoch unless an
  authorized rollback policy explicitly permits it.
- `KXD-116` Equal manifests MUST converge idempotently and transfer no current
  artifact.
- `KXD-117` Downloads MUST use node authentication, timeouts, bounded retries,
  size checks, and digest verification.
- `KXD-118` Managed skills MUST replace atomically as one deterministic overlay.
- `KXD-119` OpenCode binary and plugin ABI versions MUST converge together.
- `KXD-120` A busy session MUST defer disruptive harness or daemon replacement.
- `KXD-121` The scheduler MUST NOT assign a node whose required components are
  stale, failed, pinned, or unknown.
- `KXD-122` Health MUST report desired and actual digest/version per component,
  the manifest epoch, last convergence time, and named failure reason.
- `KXD-123` A network outage MAY keep the last working runtime active. The node
  MUST report `degraded`, not `current`, until it verifies the desired manifest.
- `KXD-124` A newly started sandbox MUST finish convergence before it reports
  session readiness. This prevents stale restored snapshots from serving work.

## 8. Daemon self-update and rollback

- `KXD-130` The running daemon MUST stage updates beside the active executable.
- `KXD-131` A supervisor outside the daemon process MUST independently verify
  the staged size and digest before promotion.
- `KXD-132` The root-owned baked daemon MUST remain an immutable recovery floor
  in managed sandbox images.
- `KXD-133` Promotion MUST be atomic and retain the previous known-good version.
- `KXD-134` A promoted daemon MUST pass a bounded startup and health probation.
- `KXD-135` Repeated early failure MUST roll back and pin the rejected update.
- `KXD-136` A pinned node MUST remain usable and MUST report the rejected digest.
- `KXD-137` An operator MUST be able to clear a pin after policy or artifact
  correction.
- `KXD-138` The API MUST expose a live self-update kill switch.
- `KXD-139` Multiple installed versions MUST be bounded and garbage-collected.
- `KXD-140` Update interruption at download, verification, staging, promotion,
  or first boot MUST leave a bootable known-good daemon.

## 9. Standalone CLI and operating-system service

- `KXD-150` `kortixd` MUST expose `run`, `connect`, `status`, `doctor`, `update`,
  `logs`, `start`, `stop`, `restart`, `logout`, `version`, and `help`.
- `KXD-151` `status --json` MUST be stable and machine-readable.
- `KXD-152` `doctor` MUST validate configuration, credential-file ownership and
  mode, API reachability, channel authentication, writable state, required host
  tools, harnesses, and convergence.
- `KXD-153` macOS LaunchAgent, Linux systemd user service, and Windows Task
  Scheduler installation MUST use the `kortixd` executable.
- `KXD-154` Service installation MUST quote paths and arguments safely.
- `KXD-155` Credentials MUST live in a regular owner-controlled file. POSIX mode
  MUST be `0600`; the containing directory MUST be `0700`.
- `KXD-156` Status and logs MUST work without API connectivity.
- `KXD-157` `logout` MUST revoke or clear credentials and stop the service.
- `KXD-158` The retired `agent-tunnel` command MAY remain for one release only
  as a message-only migration shim to `kortixd connect`.

## 10. Security and observability

- `KXD-170` Health, logs, telemetry, errors, crash reports, and audit events MUST
  not contain credentials or user secret values.
- `KXD-171` Every control request MUST have a node, session, account, and request
  correlation identity where applicable.
- `KXD-172` Metrics MUST cover connected nodes, connection churn, stream counts,
  stream bytes, backpressure, assignment latency, convergence state, update
  results, rollback, and pinned nodes.
- `KXD-173` Rate and concurrency limits MUST be enforced before allocating an
  unbounded body, buffer, process, or stream.
- `KXD-174` The API MUST reject node claims for a different account, project,
  session, or provider allocation.
- `KXD-175` Session credentials MUST be removed from process-global state before
  another assignment.

## 11. Required black-box verification

No requirement is complete until its mapped test passes.

| Suite | Required proof |
| --- | --- |
| `KXD-REST` | Create, list, get, patch, enable, disable, drain, rotate, restart, and delete a compute node. Assert auth failures and database read-back. |
| `KXD-CLI` | Run the compiled `kortixd` process for help, version, doctor, connect, status JSON, update, service operations, logout, invalid input, and unreachable API. Assert exit code, stdout, stderr, files, modes, and process state. |
| `KXD-WIRE` | Real WebSocket authentication, HMAC, nonce replay rejection, replacement, heartbeat, RPC, streaming HTTP, SSE, WebSocket, bodies, cancellation, backpressure, disconnect, reconnect, and cross-instance forwarding. |
| `KXD-CAP` | Sandbox and workstation filesystem CRUD, traversal, symlink, blocked path, size, shell allow/deny/timeout/output/cancel, port relay, desktop/CUA permission enforcement, and audit read-back. |
| `KXD-CONVERGE` | Current/no-download, stale update, digest mismatch, partial download, API 500, timeout, lower/equal/higher epoch, busy deferral, OpenCode+ABI update, skills atomicity, kill switch, and unsupported future component. |
| `KXD-UPDATE` | Daemon stage, supervisor verification, atomic promote, healthy boot, first bad update, bad update after good update, rollback, pin, clear pin, interrupted promotion, and bounded version cleanup. |
| `KXD-SESSION` | Provision a real provider allocation, observe outbound node connection, create/start a session, wait for channel-derived readiness, run a real prompt, observe SSE, filesystem CRUD, commit, stop, resume, restart, rotate credentials, run another prompt, release, and delete. |
| `KXD-ISOLATION` | Run two sequential sessions on one reused node and two concurrent sessions on separate nodes. Assert no credential, message, file, environment, port, or conversation cross-bleed. |
| `KXD-STALE` | Boot a deliberately old sandbox image. Assert it cannot become ready until `kortixd`, `kortix`, OpenCode, ABI support, and managed skills match the current manifest. |
| `KXD-FAIL` | Cut API connectivity during a turn, reconnect, kill the daemon, kill the harness, rotate the node credential, replace the channel, stop the provider allocation, and restore it. Assert explicit state and recovery. |
| `KXD-WEB` | In Chromium, create a node, view live/offline/convergence status, create a project and session, observe ready state, send a prompt, see streamed output, inspect files, stop/restart, and delete. Assert DOM, network requests, payloads, and visible results. |
| `KXD-COMPAT` | Old API/new daemon, new API/old daemon for the declared window, old snapshot entrypoint, `/p/:externalId` compatibility, agent-tunnel parity, and the message-only retirement shim. |

## 12. Release gate

The feature is shippable only when all statements below are true:

1. Every requirement has an automated test ID or an explicit documented manual
   verification where automation is impossible.
2. Repository unit, type, route, SDK, CLI, API, and browser suites pass.
3. The full `KXD-SESSION`, `KXD-STALE`, `KXD-FAIL`, and `KXD-WEB` journeys pass
   from this isolated local worktree against real provider compute.
4. The PR is merged to `main`.
5. The dev deployment reports the merge SHA for every changed surface.
6. The same black-box session and browser journeys pass against dev.
7. Fleet telemetry reports no unexpected stale, pinned, or direct-ingress node.
