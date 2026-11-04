---
recorded: 2026-11-04T13:45:08Z
incident_date: 2026-11-04
---
# Retire every template a host built on a guest kernel it no longer runs

**Rule:** When a Platinum host's guest kernel changes, deprecate every template that host built on the old kernel the same hour. Placement (`guestKernelGate`) only places a template on a host whose guest kernel matches the one stamped at build, so such a template has no host and every create from it returns `503 no capacity on a host that can mount these volumes`.

**Trigger surface:** Adding, reinstalling or re-kerneling a Platinum host; a release smoke or dev session failing with `failureCategory: provider-capacity` while the fleet has free RAM.

**Incident:** 2026-11-04. A new eu-west host first ran guest kernel `6.8.0-146-generic` and built the Kortix Dev org's default template (`kortix-default-<hash>`) at 03:59 UTC. The host was then moved to `6.8.0-88-generic`, like the rest of the fleet. From ~05:20 UTC every snapshot-based session on dev and staging failed provisioning (210 Platinum refusals in hour 05). The v0.14.19 release smoke failed RUN-7 and GOLD-1 on 3 attempts. Prod was unaffected (other org, other template). Diagnosis: `templates.guest_kernel` of the template against `hosts.guest_kernel`, and `audit_events` `sandbox.create.no_capacity` listing only the dedicated host. Fix: `DELETE /v1/templates/<id>` with the org key; Kortix rebuilt it on a 6.8.0-88 host in ~4 min, and the retried flows passed.

**Enforcement:** none yet: Platinum should deprecate templates stamped with a guest kernel no ready host runs (or rebuild them) when a host reports a new guest kernel, and its capacity diagnostic should report `guest_kernel_mismatch` instead of omitting the host.
