# Decisions: project repository access

## 2026-11-02

- **Fix the root cause, keep the project.** Deleting the large project would have hidden a defect that any project can hit. (Marko)
- **The API fetches only the objects a read names, over the git wire protocol.**
  - Host-neutral: GitHub, code.storage and any smart-HTTP host serve the same `want <id>`.
  - The REST APIs of the hosts were rejected: they are host-specific, rate-limited (5,000/h per GitHub installation), and would mean rewriting 23 modules.
  - Raw-file URLs were rejected: there is no universal one across hosts.
- **Clone commits only; never let git download on its own.**
  - `--filter=tree:0` keeps history features (merge bases, logs) without history trees or files.
  - `GIT_NO_LAZY_FETCH=1` makes a missing object fail fast. An explicit, authenticated, capped fetch then gets it.
  - Implicit lazy fetches would run without credentials, one object per round trip, with no size bound.
- **No shared config snapshot table yet.**
  - With the partial store, a replica costs kilobytes per tip move.
  - Revisit if cold reads after deploys measure high (item 3 in the README).
- **A session start never waits silently on its image.**
  - Every wait is a named step, end to end.
  - Past an 8 s budget, the session boots the image its project booted last.
- **Target: one Platinum volume per project is canonical; git is secondary.** (Marko)
  - Git lives inside the volume, behind a git API.
  - An external repository (GitHub or another host) is an optional sync target.
  - Large data is network-available on S3-backed storage instead of synced.
  - The partial object store and sparse fetching are a temporary bridge.
  - Design questions are open; see the README section "Target architecture".
- **The dev test project for the large repository is read-only** (a `generic` connection with no credential), so dev sessions cannot push into a customer's repository.
