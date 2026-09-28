---
recorded: 2026-08-23T19:05:12Z
commit: 1a16ebfc2a
---
# Update every generated Dockerfile when the sandbox runtime changes

2026-08-23. A fix changed the canonical sandbox Dockerfile, but self-hosted
template builds continued to fail. The live builder rendered its Dockerfile
from `packages/shared/src/sandbox/dockerfile-layer.ts`. The fast and meta
renderers also retained the failed command.

**The rule.** A sandbox runtime command change must update the canonical
Dockerfile and every generated Dockerfile. A passing canonical Dockerfile test
does not prove the remote template build path.

**The enforcement.** The layer, fast, and meta renderer tests assert
`pnpm root -g`. Each test rejects `pnpm list -g`. Golden snapshots make the
live layered Dockerfile change visible in review.

*Incident:* a self-hosted project template rebuild repeated the retired
OpenCode package lookup after the canonical image fix deployed.
