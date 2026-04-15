# JustAVPS Restart, Recovery, and Runtime Hardening Spec

## Goal

Make JustAVPS-backed instances behave like a robust managed product:

- restart actions must be **host-level** and reliable
- admin users must be able to restart any instance they can access
- the UI must show a clear **restarting / recovering** state instead of vague errors
- the host workload must auto-recover after reboot
- noisy container/runtime failures must either be fixed or explicitly downgraded as non-critical

---

## Problems Observed

### 1. Restart can succeed while the UI reports failure

Observed behavior:

- user clicks Restart
- host/container actually restarts
- frontend still shows `Restart failed: No sandbox to restart`

Root causes:

1. **Ownership-filtered restart lookup**
   - `/platform/sandbox/restart` filters by `accountId + sandboxId`
   - admin-bypassed access to another user’s sandbox fails that filter
2. **Synchronous reboot semantics**
   - backend waits too long for the whole machine/runtime to recover
   - reboot kills connectivity mid-request, so caller sees an error even when reboot was successfully dispatched

### 2. Post-restart UX is weak

Observed behavior:

- UI says `Workspace offline`
- then `Retrying automatically`
- restart does not clearly transition to a distinct “host restart requested / waiting for services” state

### 3. Host runtime recovery is only partially explicit

Current good pieces:

- `justavps-docker.service` already exists
- it is `Restart=always`
- systemd starts the sandbox workload container on boot

Still missing:

- a single canonical restart flow that dispatches reboot/start and immediately puts UI into a recovery state
- a defined manual recovery procedure
- stronger guarantees that Docker + workload service are reset cleanly after failure

### 4. In-container runtime logs show repeated noisy failures

Observed log classes:

- `./run: /sys/fs/cgroup/... No such file or directory`
- `Read-only file system`
- `dbus-daemon ... org.freedesktop.login1 ... Permission denied`
- `xfce4-session` / `startwm.sh` aborts
- `svc-docker ... failed to create NAT chain DOCKER ... iptables ... Permission denied`
- transient `OpenCode unreachable on localhost:4096` during boot

Important distinction:

- **some are boot-time/transient and acceptable**
- **some indicate real misconfiguration or unnecessary services**
- **some are likely non-critical noise from unsupported subsystems**

### 5. Auth model is inconsistent with “admin can operate any accessible instance”

Current state:

- some routes are correctly ownership-scoped
- some routes have ad-hoc admin bypass logic
- restart/stop/access flows are not consistently modeled around **access** vs **ownership**

---

## Product Requirements

### R1. Restart semantics

Restart for JustAVPS must mean:

1. dispatch a **host-level restart** (or start if stopped)
2. do **not** wait for the full reboot synchronously in the request path
3. mark the instance as `restarting` / `recovering`
4. after boot, auto-start the managed workload service
5. once health checks recover, clear restarting state

### R2. Access semantics

For instance actions, the system should check:

- **owner access** for normal users
- **admin access** for admins/super_admins

The system should stop using plain `accountId + sandboxId` filters in places where the real rule is “caller may operate this sandbox”.

### R3. UI semantics

After restart is clicked, UI must show:

- `Restarting host`
- `Waiting for machine to come back`
- `Recovering core services`
- optional elapsed timer

It must not keep showing a generic failure if the reboot request was accepted.

### R4. Runtime robustness

The host must guarantee on every boot:

- Docker daemon available on host
- `justavps-docker.service` enabled and active
- workload container recreated if missing
- `kortix-master` reachable on port 8000 once workload is healthy

### R5. Manual recovery

Operators must have a documented, copy-paste-safe recovery sequence.

---

## Engineering Plan

## A. Introduce canonical sandbox access resolution

Create a shared helper, e.g.:

`resolveSandboxAccess(userId, sandboxId?, options)`

Behavior:

- resolve caller account
- detect platform role (`user | admin | super_admin`)
- if admin and `sandboxId` provided: allow direct lookup by `sandboxId`
- otherwise enforce ownership via `accountId`

Use this helper in at least:

- `/platform/sandbox/restart`
- `/platform/sandbox/stop`
- `/platform/sandbox/ssh`
- `/platform/sandbox/list?sandbox_id=...`
- any instance-scoped action route that currently assumes ownership instead of access

### Acceptance criteria

- admin can restart another user’s instance without fallback hacks
- normal user cannot operate another user’s instance

---

## B. Split “dispatch restart” from “wait for recovery”

Add two provider-level concepts for JustAVPS:

1. `dispatchHostRestart(externalId)`
   - issues `start` or `reboot` or fallback `stop/start`
   - returns immediately once the provider accepted the action
2. `waitForHostRecovery(externalId)`
   - waits for machine status `ready`
   - restarts / validates `justavps-docker`
   - checks `/kortix/health`

### API route behavior

For UI-facing restart endpoints:

- return `202 Accepted` or success payload immediately after dispatch
- include response like:

```json
{
  "success": true,
  "data": {
    "state": "restarting",
    "recovery": "pending"
  }
}
```

Do **not** hold the request open until full reboot completes.

---

## C. Add explicit frontend recovery state

Extend sandbox connection state with fields like:

- `hostRestartRequestedAt`
- `recoveryPhase`: `idle | restarting_host | waiting_for_runtime | reconnecting`

### UI behavior

When restart is clicked:

- immediately enter `restarting_host`
- show blocking overlay on instance pages
- disable repeat restart clicks briefly
- sidebar should show the same recovery state, not generic “Failed to connect”

Suggested copy:

- **Restarting host**
- `The machine accepted the restart. Waiting for the host and core services to come back online.`

Then transition automatically to:

- **Recovering workspace services**
- `The host is back. Waiting for Kortix services to finish starting.`

Only show actual failure if:

- provider action request failed before dispatch, or
- recovery exceeds a timeout threshold

---

## D. Harden host-managed workload service

Current service is good but should be strengthened.

### Current generated unit

`/etc/systemd/system/justavps-docker.service`

Current properties:

- `After=network-online.target docker.service`
- `Requires=docker.service`
- `Restart=always`

### Proposed improvements

Add / verify:

- `StartLimitIntervalSec=0`
- `RestartSec=3`
- `ExecStartPre=/bin/systemctl reset-failed docker.service || true`
- `ExecStartPre=/usr/bin/docker rm -f justavps-workload || true`
- optional host-level wait for iptables/network readiness before `docker run`

### Host recovery command should also do

```bash
systemctl reset-failed docker.service justavps-docker.service || true
systemctl restart docker.service
systemctl restart justavps-docker.service
```

then wait for:

- container exists and is `running`
- `curl -fsS http://localhost:8000/kortix/health`

---

## E. Document manual recovery

### Host-level manual recovery

```bash
systemctl reset-failed docker.service justavps-docker.service || true
systemctl restart docker.service
systemctl restart justavps-docker.service
systemctl status docker.service --no-pager -n 50
systemctl status justavps-docker.service --no-pager -n 50
docker ps -a
curl -fsS http://localhost:8000/kortix/health
```

### If container exists but app is still booting

```bash
docker logs -f justavps-workload
```

### If service must be rebuilt from the host bootstrap script

```bash
curl -fsSL https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/start-sandbox.sh -o /usr/local/bin/kortix-start-sandbox.sh
chmod +x /usr/local/bin/kortix-start-sandbox.sh
/usr/local/bin/kortix-start-sandbox.sh kortix/computer:0.8.42
```

---

## F. Investigate / suppress noisy in-container errors

### 1. `svc-docker` / inner dockerd failure

Observed:

- inner Docker daemon repeatedly fails with iptables permission errors

Interpretation:

- Docker-in-Docker inside the sandbox container is not actually available with current privileges
- service is retrying forever and polluting logs

Action:

- decide whether nested Docker is truly required
- if **not required**, disable `svc-docker` entirely for JustAVPS images
- if required, fix privileges/network mode so iptables NAT setup succeeds

Recommendation:

- **disable it unless there is a proven product need**

### 2. `xfce4-session` / `startwm.sh` aborts

Observed:

- desktop session aborts and restarts repeatedly

Likely cause:

- login/dbus/systemd user-session expectations not available in this container profile

Action:

- determine whether desktop is still functionally usable despite restart noise
- if not, replace fragile XFCE startup path with a minimal window-manager/session bootstrap

### 3. cgroup / read-only filesystem errors

Observed:

- `/sys/fs/cgroup/...` missing or read-only

Action:

- patch the offending `./run` scripts to feature-detect cgroup support before writing
- downgrade to warnings instead of repeated hard errors

### 4. dbus/login1 noise

Observed:

- `org.freedesktop.login1` activation denied

Action:

- avoid components that require host login1 integration, or
- ignore if harmless after confirming it does not break desktop/browser workflows

---

## G. Clarify what is actually “ready”

Current reality:

- container running != OpenCode ready

System should model readiness in stages:

1. `host_rebooting`
2. `container_starting`
3. `core_proxy_ready` (`/global/health`)
4. `opencode_ready` (OpenCode behind localhost:4096 is responding)
5. `workspace_ready`

UI should reflect this instead of binary reachable/unreachable only.

---

## Proposed Implementation Order

### Phase 1 — correctness

1. shared sandbox access helper
2. refactor restart API to dispatch immediately
3. frontend recovery state after restart click

### Phase 2 — host/runtime hardening

4. strengthen `justavps-docker.service`
5. host recovery command resets/restarts Docker + workload service
6. document manual recovery

### Phase 3 — noise reduction

7. disable or fix `svc-docker`
8. patch cgroup writes in `./run`
9. reduce XFCE/login1/dbus churn

---

## Acceptance Tests

### Restart behavior

- admin on another user’s instance clicks Restart
- API returns success immediately
- UI enters `Restarting host`
- no false failure toast
- instance returns to healthy state without manual intervention

### Stopped host behavior

- admin clicks Restart on a stopped instance
- host starts
- UI shows recovery state
- container/service comes back

### Ownership/access behavior

- owner can restart own instance
- admin can restart any visible instance
- non-admin cannot restart another account’s instance

### Host boot recovery

- reboot machine externally
- `docker.service` starts
- `justavps-docker.service` starts
- `justavps-workload` appears
- `/kortix/health` returns success

### Noise reduction

- no repeated inner dockerd crash loop unless explicitly enabled
- cgroup write errors eliminated or downgraded
- desktop session no longer thrashes endlessly

---

## Known Likely Root Cause of Current Runtime Noise

The biggest concrete problem from the logs is:

- **an inner Docker service is being started inside the sandbox container without the privileges/networking it expects**

That causes:

- repeated `iptables ... Permission denied`
- `svc-docker` crash loop
- extra noise and instability during boot

This should be treated as a first-class hardening task, not ignored.

---

## Summary

This work should refactor the system from:

- ownership-filtered restart calls
- synchronous reboot requests
- vague offline UI
- noisy but unmanaged runtime failures

into:

- access-based instance operations
- async host restart dispatch + explicit recovery state
- guaranteed host service auto-recovery
- reduced runtime noise and better operational debugging
