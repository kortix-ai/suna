# ADR-006: Local Sandbox Runtime for Ordinary Linux VPS Hosts

- **Status:** Proposed
- **Date:** 2026-08-07
- **Deciders:** Platform Engineering

## Context

Self-hosted Kortix currently runs its control plane locally but requires a
configured cloud sandbox provider for agent sessions. The retired
`local-docker` provider did not meet the product contract. It mounted the host
Docker socket into `kortix-api`, made the API process a container supervisor,
and exposed the host through a root-equivalent control socket.

The replacement must run a complete Kortix stack on one ordinary Linux VPS.
The host might not expose nested virtualization or `/dev/kvm`. The operator has
root access to the VPS, but does not control its hypervisor.

The runtime must provide:

- x86_64 and arm64 Linux support;
- no dependency on `/dev/kvm` or nested virtualization;
- OCI image and Dockerfile compatibility;
- process execution, PTY, file transfer, TCP ingress, and outbound networking;
- CPU, memory, process, and disk limits;
- persistent writable workspaces across stop and start;
- an isolation boundary suitable for untrusted agent-generated code;
- one install and upgrade path for the complete self-host stack;
- no host container-runtime socket inside `kortix-api`.

“Any VM” means a standard Linux VPS with root access, Linux 4.14.77 or newer,
and normal namespace, cgroup, seccomp, and network capabilities. No runtime can
support restricted container-based VPS products that disable those kernel
features.

## Decision

Do not implement smolVM as the default local sandbox runtime. smolVM uses KVM
on Linux and requires `/dev/kvm`. It therefore fails the ordinary-VPS
requirement.

Prototype a separate host service named `sandboxd`. Use containerd for OCI
image, snapshot, and lifecycle management. Use gVisor `runsc` with the default
`systrap` platform for workload execution.

Do not call this provider smolVM or “small VM”. gVisor is an application kernel,
not a hardware virtual machine. A future product-facing provider name must state
that it is a local sandbox. Keep smolVM as a possible KVM-enabled backend only.

The control boundary is:

```text
kortix-api -> authenticated sandboxd API -> containerd -> runsc/systrap
                                              |
                                              +-> isolated OCI workload
```

`kortix-api` receives a narrow authenticated API. It does not receive the
containerd socket, the Docker socket, or host root authority. `sandboxd` owns
image pulls, CNI networking, cgroups, workspace volumes, logs, health, stop,
resume, and deletion.

This ADR does not authorize a production provider implementation. The prototype
must pass the acceptance gate below first.

## Why gVisor `systrap`

gVisor implements a Linux-like application kernel in userspace. Its `runsc`
binary implements the OCI runtime contract. The `systrap` platform intercepts
system calls through seccomp and does not require hardware virtualization.
Upstream recommends `systrap` inside VMs and on machines without virtualization
support. It has been the default platform since 2023.

The runtime supports containerd integration and checkpoint/restore. Host cgroups
enforce sandbox-level resource limits. The current release supports x86_64 and
arm64 on Linux 4.14.77 or newer.

A no-KVM smoke ran successfully inside Docker Desktop's Linux VM on 2026-08-07:

```text
Linux 6.10.14-linuxkit aarch64
no-/dev/kvm
runsc platform: systrap
Linux ... 4.19.0-gvisor ... aarch64
Starting gVisor...
gvisor-systrap-ok
```

This smoke proves the no-KVM execution path. It does not prove the complete
Kortix workload contract.

## Candidate Matrix

| Runtime | No KVM on Linux VPS | OCI workload | Isolation boundary | Decision |
|---|---:|---:|---|---|
| gVisor `runsc --platform=systrap` | Yes | Yes | Userspace application kernel plus host namespaces | Prototype |
| smolVM | No | Yes | Per-workload VM and guest kernel | Reject as default; optional KVM backend |
| Microsandbox | No | Yes | MicroVM | Reject as default; beta |
| BoxLite | No | Yes | Per-workload VM and guest kernel | Reject as default |
| Shuru | No | Partial | Per-workload VM and guest kernel | Reject; Linux is arm64-only and experimental |
| Firecracker, Kata, and Cloud Hypervisor | No | Yes | MicroVM or VM | Reject as default |
| Hyperlight | No | No | Kernel-free microVM functions | Reject; not a general Linux runtime |
| Sysbox | Yes | Yes | Shared host kernel with user namespaces | Reject for primary isolation and Docker coupling |
| Incus unprivileged containers | Yes | Partial | Shared host kernel with user namespaces | Keep as an operator-oriented fallback candidate |
| Rootless Podman with `crun` or `runc` | Yes | Yes | Shared host kernel | Reject for untrusted-code isolation |
| Pullrun container backend | Yes | Yes | Shared host kernel through `runc` | Watch; early project and no stronger no-KVM boundary |
| Bubblewrap, nsjail, Landlock wrappers | Yes | No complete manager | Shared host kernel | Reject as primitives, not a complete provider |
| QEMU TCG | Yes | Image conversion required | Per-workload VM and guest kernel | Reject for performance and operations cost |
| WASI runtimes | Yes | No | Capability-based userspace runtime | Reject; OpenCode and browser workloads need Linux |

smolVM remains technically attractive on bare metal or a VPS that exposes
nested virtualization. It provides OCI images, fast microVM boot, port
forwarding, persistent machine artifacts, and a separate guest kernel. Those
benefits do not remove its mandatory Linux KVM dependency.

## Known gVisor Gaps

gVisor implements a large subset of Linux, not every Linux syscall and device.
The relevant upstream limitations are:

- `io_uring` is disabled by default and supports only basic operations when
  enabled;
- block-device filesystems cannot be mounted inside the sandbox;
- `iptables` and `nftables` support is incomplete;
- custom hardware devices are generally unavailable;
- in-sandbox cgroups account for resources but do not enforce limits between
  processes in one sandbox;
- rootless modes have networking, UID mapping, and checkpoint restrictions.

Kortix must apply CPU and memory limits to the whole `runsc` process tree with
host cgroups. The first implementation should run `sandboxd` as a dedicated
root-owned service. Rootless operation is a later hardening track, not an
acceptance dependency.

Chromium is a required compatibility risk. The prototype must execute the
actual Kortix base image and browser toolchain. A BusyBox or Node.js smoke is
not sufficient.

## Prototype Acceptance Gate

Test the same immutable build on Hetzner Cloud, DigitalOcean, AWS EC2 without
nested virtualization, and one arm64 VPS. Each host must have no `/dev/kvm`.

The prototype passes only if all checks succeed:

1. Install the full self-host stack with one documented command.
2. Start two concurrent agent sessions from the real API.
3. Execute shell, Git, Node.js, Python, PTY, and file operations.
4. Run the real Chromium browser tool and complete one page interaction.
5. Expose ports 3000 and 8000 through the existing proxy contract.
6. Verify outbound DNS, HTTPS, and explicit blocked-egress policy.
7. Enforce CPU, memory, process-count, and disk limits from the host.
8. Stop and start a session without losing `/workspace` data.
9. Kill `sandboxd` and the API independently. Recover without orphaned leases.
10. Attempt namespace, mount, device, cgroup, and host-socket escapes.
11. Upgrade the self-host stack without deleting active workspace data.
12. Record cold start, warm start, build, CPU, memory, and disk overhead.

Any compatibility failure in the Kortix base image, OpenCode, Chromium, Git,
or the proxy contract blocks implementation. A failed host-kernel prerequisite
must produce a preflight error before the stack starts.

## Consequences

**Positive**

- The primary path works without nested virtualization.
- OCI images preserve the existing Dockerfile and snapshot build model.
- gVisor exposes less host-kernel attack surface than `runc` containers.
- A separate service removes root-equivalent runtime authority from the API.
- The architecture can add a KVM backend later without changing API callers.

**Negative**

- gVisor is not a VM boundary and shares the host kernel below its application
  kernel.
- Linux compatibility is high but incomplete.
- Kortix must own `sandboxd`, containerd, CNI, cgroup, storage, cleanup, and
  upgrade behavior.
- “Any VM” still excludes restricted VPS containers and unsupported kernels.

## Sources

Accessed 2026-08-07.

- [smolVM README: Linux requires KVM and `/dev/kvm`](https://github.com/smol-machines/smolvm#platform-support)
- [gVisor platform guide: `systrap` for VMs or hosts without virtualization](https://gvisor.dev/docs/architecture_guide/platforms/)
- [gVisor installation requirements](https://gvisor.dev/docs/user_guide/install/)
- [gVisor containerd integration](https://gvisor.dev/docs/user_guide/containerd/quick_start/)
- [gVisor application compatibility](https://gvisor.dev/docs/user_guide/compatibility/)
- [gVisor checkpoint and restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/)
- [gVisor rootless limitations](https://gvisor.dev/docs/user_guide/rootless/)
- [Microsandbox README: Linux requires KVM](https://github.com/zerocore-ai/microsandbox#readme)
- [BoxLite README: Linux requires accessible `/dev/kvm`](https://github.com/boxlite-ai/boxlite#system-requirements)
- [Shuru README: Linux support is experimental, arm64-only, and requires KVM](https://github.com/superhq-ai/shuru#requirements)
- [Hyperlight README: not for full Linux workloads](https://github.com/hyperlight-dev/hyperlight#readme)
- [Sysbox installation model](https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-package.md)
- [Incus security model](https://linuxcontainers.org/incus/docs/main/explanation/security/)
- [Podman rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md)
- [Pullrun README: Linux containers use `runc`; VM mode requires `/dev/kvm`](https://github.com/pullrun/pullrun#readme)
- [Bubblewrap security model](https://github.com/containers/bubblewrap#security)
