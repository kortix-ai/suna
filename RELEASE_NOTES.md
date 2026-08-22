Bound database capacity and reliable production web deploys

### Fixed

- Bound API database pools against the maximum rolling deployment fleet. This prevents PostgreSQL `53300` connection exhaustion.
- Isolated audit writes on a dedicated pool. Slow audit inserts cannot starve request handlers.
- Coalesced project environment updates, bounded secret writes, and capped concurrent project sessions to contain request storms.
- Bound public web version metadata to each Vercel deployment. Production web deploys now complete with the correct release version.
- Strengthened release verification for warm-session adoption.
