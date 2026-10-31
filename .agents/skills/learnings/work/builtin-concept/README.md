---
title: One builtin concept for everything Kortix ships (My Kortix first)
status: in progress on branch my-kortix-v2 (PR #11240)
owner: my-kortix-v2 session
updated: 2026-10-30
---

# One builtin concept

## The problem

Founder, 2026-10-30: "refactor all of that MY KORTIX / META STUFF, including image should be handelled like a builtin default etc … make sure we aint duplicating code but just have a BUILTIN CONCEPT for any of the things that user can add just like BUILTIN where it comes from our side". He chose "Full unify".

Mapped on 2026-10-30 (branch head 84dc24230e): about 45 sites ask "is this My Kortix?" by slug. Only `BUILTIN_AGENTS` (packages/shared/src/my-kortix-agent.ts) and the `builtin_agents` switch are generic. Three different rules decide "is My Kortix on" (session-create, grants `isLaunchableAgentName`, session-token-grant `myKortixEnabled`); restart (session-lifecycle/actions.ts) and token mint (session-sandbox.ts) never check it. The My Kortix image runs a parallel path (`ensureMyKortixSandboxImage`, its own fingerprint, name, reap, fallback `servedMetaImages` from #11241) beside `ensureSandboxImage`.

## The design

A builtin is a definition shipped by the platform that goes through the same path as a user-added one, with declarative properties instead of name checks.

- **Agent descriptor** in `BUILTIN_AGENTS`: `sandbox`, `sandboxLocked`, `grant: 'as_user'`, `prompt: 'platform'`, `tools`, `noProjectCheckout`, `openToEveryMember`, `recursion: 'one-runner-level'`, `defaultAgent`, `ui` (`featured`, `noAgentPage`, `displayName`, `mark`). Code reads properties; one `builtinAgentConfig(key)` replaces addMyKortixAgent / myKortixAgentGrant / resolveMyKortixSandbox / MY_KORTIX_TOOLS / buildMyKortixConfig.
- **One enablement function** used by create, launchable, grant, re-mint, restart.
- **Image as a template row**: slug `mykortix`, 1 CPU / 2 GB / 8 GB, Dockerfile from the builtin renderer, `namePrefix kortix-mykortix` (env-namespaced), booted by `ensureSandboxImage` (dedupe, CAS agent swap, lastReady, `recordTemplateBuilt`, pre-build, release gate). Delete the meta ensure/fingerprint/reap/fallback. The reaper still tidies the legacy `kortix-meta-<env>-*` prefix and protects served legacy images until no box runs one.
- **Runtime role**: the API sends `KORTIX_RUNTIME_ROLE=coordinator` from the descriptor; the box reads it and the legacy `KORTIX_META_AGENT=1` during rollout.
- **Release variant** `builtin:<key>` (alias `mykortix`); quarantine filters by variant, not slug.
- **Tool and skill registries**: one `{name, default_on, ejectable, platform_only}` list each, the duplicated name lists derived from it.
- **Reserved slugs**: every builtin sandbox slug is reserved like `default`.
- **Clients** read `agent.builtin` and descriptor `ui` fields; the server owns the sandbox lock.

## Legacy alias, in one place

`canonicalAgentName`, `isMyKortixAgentName`, the reserved-slug check, the reaper prefix, the `meta_agent` flag fallback, the pixel-mark `meta` entry.

## Overlap

PR #11236 (one-schema) edits projects/agents/*, manifest-schema and `builtin_agents`; coordinate before touching those. #11241 (on dev) owns the meta image fallback this replaces.
