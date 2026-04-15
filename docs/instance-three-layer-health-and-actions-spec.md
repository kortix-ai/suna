# Instance Health & Actions — Three-Layer Model Spec

## Purpose

Replace the current confusing restart/offline handling with one clean model.

We explicitly separate **three layers**:

1. **Host layer** — the JustAVPS machine itself
2. **Workload layer** — the `justavps-docker` systemd service + `justavps-workload` container on that host
3. **Core runtime layer** — services *inside* the workload container (`kortix-master`, OpenCode, desktop/session, agent-browser, etc.)

The current UX mixes these layers together. This spec defines how to split them cleanly in:

- health/status reporting
- instance management actions
- unreachable/offline UI

---

## What the current logs actually show

From the observed behavior and logs:

### Layer 1 — Host
- host is often still reachable over SSH
- JustAVPS machine itself is often **not** the real problem

### Layer 2 — Workload service/container
- `justavps-workload` container often restarts successfully
- `justavps-docker.service` is the correct host-managed abstraction for this layer

### Layer 3 — Core runtime inside container
- `localhost:8000` can come up before OpenCode is truly ready
- `session/status`, `session`, `global/event` can fail while `/global/health` is temporarily okay-ish
- this is why the frontend ends up in weird sub-states

### Extra noise seen in logs

These are separate from the 3-layer health model but must be addressed:

1. **Inner Docker crash loop**
   - `svc-docker`
   - `iptables ... Permission denied`
   - likely unnecessary for managed JustAVPS workloads

2. **cgroup write errors**
   - `/sys/fs/cgroup/...` missing or read-only
   - scripts assume writable cgroups when they should feature-detect first

3. **desktop / dbus / login1 noise**
   - `xfce4-session`, `login1`, `dbus` permission-denied churn
   - may be partly harmless, but currently pollutes logs and can destabilize desktop session startup

---

## The new model

## Layer 1 — Host

Represents the VM / machine itself.

### Health signals
- JustAVPS machine status: `ready | stopped | provisioning | error | deleted`
- host IP exists / machine metadata available
- optional: last provider heartbeat if available

### Actions
- `start_host`
- `reboot_host`
- `stop_host`

### When to use
- only when the machine itself is offline, stopped, errored, or truly unreachable
- **not** the default fix for most incidents

---

## Layer 2 — Workload service

Represents the host-managed workload on that machine.

### Concrete things this includes
- `docker.service` on host
- `justavps-docker.service`
- `justavps-workload` container existence and running state

### Health signals
- `systemctl is-active docker.service`
- `systemctl is-active justavps-docker.service`
- `docker inspect justavps-workload --format '{{.State.Status}}'`

### Actions
- `start_workload`
- `restart_workload`
- `stop_workload`

### This should be the **default repair action**

In most “workspace offline” cases, this is what the user really wants.

It should run roughly:

```bash
systemctl reset-failed docker.service justavps-docker.service || true
systemctl restart docker.service
systemctl restart justavps-docker.service
```

then wait for:

```bash
docker inspect justavps-workload --format '{{.State.Status}}'
curl -fsS http://localhost:8000/kortix/health
```

---

## Layer 3 — Core runtime services inside the container

Represents the actual app stack inside `justavps-workload`.

### Concrete things this includes
- `kortix-master` on port 8000
- OpenCode on port 4096 behind Kortix master
- desktop/session process
- agent-browser / viewer
- static web
- any other managed core services exposed by ServiceManager

### Health signals
- `/kortix/health`
- `/global/health`
- `/session/status`
- `/global/event`
- `/kortix/services`

### Actions
- `restart_core_runtime`
- `restart_opencode`
- `restart_desktop`
- `restart_browser_services`

### Notes

This layer should use **in-container service management**, not host reboot.

Preferred path:
- expose/consume ServiceManager/Kortix core routes
- restart only the failing service(s)

---

## Principle: default action order

When the UI detects problems, actions should escalate in this order:

1. **Restart core runtime** (layer 3)
2. **Restart workload service/container** (layer 2)
3. **Reboot/start host** (layer 1)

Current UX jumps too quickly to “restart host”.

That should change.

---

## Health endpoint design

We need a dedicated health endpoint that returns all three layers explicitly.

Recommended route:

- admin/internal: `GET /v1/admin/api/sandboxes/:id/health`
- later maybe user-safe variant if needed

### Response shape

```json
{
  "sandbox_id": "04cf77fc-f258-46d1-8cf2-5ebe47464636",
  "overall_status": "degraded",
  "recommended_action": "restart_workload",
  "layers": {
    "host": {
      "status": "healthy",
      "machine_status": "ready",
      "reachable": true,
      "details": {
        "provider": "justavps",
        "ip": "204.168.x.x",
        "last_heartbeat_at": "..."
      },
      "actions": ["reboot_host", "stop_host"]
    },
    "workload": {
      "status": "degraded",
      "docker_service": "active",
      "workload_service": "failed",
      "container_status": "exited",
      "details": {
        "systemd_unit": "justavps-docker.service",
        "container_name": "justavps-workload"
      },
      "actions": ["start_workload", "restart_workload", "stop_workload"]
    },
    "runtime": {
      "status": "degraded",
      "kortix_health": "ok",
      "opencode_ready": false,
      "session_status_ok": false,
      "event_stream_ok": false,
      "services": {
        "opencode-serve": "crashed",
        "chromium-persistent": "running",
        "agent-browser-viewer": "running"
      },
      "actions": ["restart_core_runtime", "restart_opencode", "restart_desktop"]
    }
  }
}
```

### Layer statuses

Each layer should normalize to:

- `healthy`
- `degraded`
- `offline`
- `unknown`

### Overall status rules

- if host offline → overall = `offline`
- else if workload offline → overall = `offline`
- else if runtime degraded/offline → overall = `degraded`
- else `healthy`

### Recommended action rules

- host not ready/stopped → `start_host` or `reboot_host`
- host healthy but workload broken → `restart_workload`
- host + workload healthy but runtime broken → `restart_core_runtime`

---

## Instance management panel design

The instance management panel should show the 3 layers directly.

## Layout

### Card 1 — Host
- status badge
- provider machine status
- buttons:
  - Start host
  - Reboot host
  - Stop host

### Card 2 — Workload
- docker service status
- `justavps-docker.service` status
- container running/exited
- buttons:
  - Start workload
  - Restart workload
  - Stop workload

### Card 3 — Core runtime
- Kortix master status
- OpenCode status
- event/session status
- key services summary from ServiceManager
- buttons:
  - Restart core runtime
  - Restart OpenCode
  - Restart desktop

### Important UI rule

No vague combined messaging like:

- “Workspace offline” only
- “Restarting host” when really only workload restart is desired

Instead:

- show **which layer is broken**
- show **which action is being run**

Example:

- `Host healthy`
- `Workload restarting`
- `Runtime waiting for OpenCode`

---

## Unreachable-state UX after the panel is done

Only after the instance management panel is correct should we propagate the same model into the full-screen unreachable state.

The full-screen state should then read from the same 3-layer health model and show:

- broken layer
- recommended action
- advanced actions expander

For example:

### Case A — Host down
- title: `Host offline`
- action: `Start host`

### Case B — Host fine, workload broken
- title: `Workspace container offline`
- action: `Restart workload`

### Case C — Host + workload fine, runtime broken
- title: `Workspace services unavailable`
- action: `Restart core runtime`

---

## Action API design

We should stop overloading one ambiguous restart action.

Instead define explicit operations.

### Admin actions

Suggested route:

- `POST /v1/admin/api/sandboxes/:id/repair`

Body:

```json
{ "action": "restart_workload" }
```

Allowed values:

- `start_host`
- `reboot_host`
- `stop_host`
- `start_workload`
- `restart_workload`
- `stop_workload`
- `restart_core_runtime`
- `restart_opencode`
- `restart_desktop`

### Execution mapping

#### Host actions
- JustAVPS provider API (`/start`, `/stop`, `/reboot`)

#### Workload actions
- host exec:

```bash
systemctl restart justavps-docker.service
```

or start/stop equivalents

#### Runtime actions
- call into Kortix core routes / ServiceManager inside container

Potentially:

- `/kortix/core/restart`
- `/kortix/services/:id/restart`

If these routes don’t exist yet, add them.

---

## State model simplification

We should remove weird mixed frontend states and replace them with one canonical state model.

### Current confusing states to remove or reduce
- generic `Workspace offline`
- generic `Restarting host`
- sidebar-only error while main UI still renders
- health based only on `/global/health`

### Replace with

```ts
type InstanceHealthState = {
  overall: 'healthy' | 'degraded' | 'offline' | 'recovering';
  brokenLayer: 'host' | 'workload' | 'runtime' | null;
  recoveryAction:
    | 'start_host'
    | 'reboot_host'
    | 'restart_workload'
    | 'restart_core_runtime'
    | null;
  recoveryInFlight: boolean;
}
```

---

## Explanation of the specific errors in the logs

### `iptables ... Permission denied` from `svc-docker`

Meaning:
- an inner Docker daemon is trying to start inside the workload container
- it lacks the privileges/network environment it expects

Action:
- disable inner Docker by default for JustAVPS-managed workloads unless there is a proven requirement

### `/sys/fs/cgroup/...` missing or read-only

Meaning:
- some service scripts assume writable cgroups
- container runtime does not expose them that way

Action:
- patch those scripts to feature-detect before writing

### `login1` / `dbus` errors

Meaning:
- desktop session expects host-style session integration that is not fully available

Action:
- likely reduce or suppress at source unless it proves functionally harmful

### `OpenCode unreachable on localhost:4096`

Meaning:
- layer 3 runtime not yet ready, even if layer 2 container is already up

Action:
- treat this as runtime degradation, not host failure

---

## Manual operator commands by layer

## Layer 1 — Host

```bash
# via JustAVPS API / provider control, not shell usually
```

## Layer 2 — Workload

```bash
systemctl reset-failed docker.service justavps-docker.service || true
systemctl restart docker.service
systemctl restart justavps-docker.service
systemctl status justavps-docker.service --no-pager -n 50
docker ps -a
```

## Layer 3 — Runtime

```bash
curl -fsS http://localhost:8000/kortix/health
curl -fsS http://localhost:8000/global/health
curl -fsS http://localhost:8000/session/status
curl -fsS http://localhost:8000/kortix/services
docker logs -f justavps-workload
```

---

## Recommended implementation order

### Phase 1 — model + health
1. add 3-layer health endpoint
2. normalize statuses + recommended action
3. wire instance management panel to show all 3 layers

### Phase 2 — actions
4. add explicit repair/action API for all 3 layers
5. make panel buttons execute correct layer-specific actions
6. ensure async recovery states are clear and simple

### Phase 3 — unreachable UX
7. reuse same 3-layer model in the full-screen unreachable/offline UI
8. remove redundant weird sub-states and sidebar-only confusion

### Phase 4 — runtime hardening
9. disable/fix inner Docker crash loop
10. patch cgroup write assumptions
11. reduce desktop/dbus/session noise

---

## Acceptance criteria

### Health clarity
- every instance has explicit host/workload/runtime health
- recommended action is deterministic

### Action clarity
- no ambiguous “Restart” button
- buttons always say exactly what they do

### UX clarity
- main UI always shows the real broken layer
- no more sidebar-only failure while dashboard looks normal

### Operational clarity
- manual commands exist for each layer
- logs map clearly to one of the three layers

---

## Final takeaway

The core mistake right now is treating “instance health” as one thing.

It is actually **three separate layers**:

1. machine
2. workload container/service on machine
3. app/runtime inside that container

Until the product models those layers explicitly, restart/offline UX will keep feeling random.
