---
recorded: 2026-10-15T15:04:55Z
incident_date: 2026-10-15
---
# Allocate a worktree slot only if no registry entry holds it, and search far enough to find one

**Rule:** A free port block is not a free slot. Skip every slot a registry entry holds before you probe ports: a stopped worktree listens on nothing, yet its block is still its own. Search past foreign listeners with a bound measured in slots, not a fixed handful of retries. Throw inside `withLock`, never `process.exit`: an exit skips the unlock and blocks every other `pnpm worktree` call for up to 60 s.

**Trigger surface:** Changing slot allocation in `pnpm worktree create` (`scripts/worktree/lib/registry.ts`, `cli.ts`), or any code that runs inside `withLock`.

**Incident:** On 2026-10-15, `pnpm worktree create` failed with "could not find a free port block after 6 slots" on a machine with 59 registered worktrees. The loop started at the lowest unregistered slot and then ran `slot++` through registered slots. Two of the six probed slots belonged to registered worktrees whose Supabase ports were up. The same `slot++` had already given one slot to three worktrees (2026-09-28 and 2026-10-06), the gap the 2026-10-03 foreign-listener entry left open. Worktrees that share a slot share every port, and `start` frees its slot's web/API/gateway ports by killing their listeners: the other worktree's servers.

**Enforcement:** `scripts/worktree/__tests__/pure.test.ts` → `pickSlot` (10 consecutive clashing slots, a registered slot with free ports, the search bound), run by the `worktree-unit` lane of `pnpm test`. `pnpm worktree doctor` flags a slot two worktrees share.
