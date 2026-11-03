---
recorded: 2026-11-02T17:58:53Z
incident_date: 2026-11-02
---
# Never copy a whole git repository onto an API replica; fetch only the objects a request names

**Rule:** The API keeps a partial store per project (`apps/api/src/projects/git/object-store.ts`). It clones commits only (`--filter=tree:0`) and fetches trees and files by id, in one authenticated, byte-capped request per read. Every git process runs with `GIT_NO_LAZY_FETCH=1`. A read that names `<rev>:<path>` fetches first (`ensurePathObjects`), because a missing file prints the same "bad object" error as an absent path. A whole-tree producer (zip, config archive, project snapshot, fast-boot bundle, search) passes a byte cap and maps `ObjectFetchTooLargeError` to its existing too-large outcome. Never raise a clone timeout or a cache budget to fit a large repository.

**Trigger surface:** Any new `git` command against a project store (`refreshMirror`, `repoCachePath`, a `GIT_ALTERNATE_OBJECT_DIRECTORIES` scratch repo), any new `spawn('git', …)`, a push from the store (use `--no-thin`), `write-tree` (use `--missing-ok`), and the clone/fetch flags in `mirror.ts`.

**Incident:** 2026-11-02, prod. Every API replica ran `git clone --bare` of every project repository it touched: all history, all files, re-cloned after each deploy and after each eviction from the 4 GiB cache. One project held 6,388 MB of history (1,056 MB at the tip). Its clone never finished inside 90 s × 3 attempts, so `GET /v1/projects/:id/detail` answered 503 `request_deadline` and session creates retried the clone. VPC flow logs for 24 h to 16:00Z: GitHub was 577 of 809 GB of prod NAT inbound (71.3%). The partial store fetches about 400 KB for the same project. Error messages also carried `git show` stdout (file content) into logs on a buffer overflow; `classifyGitError` no longer uses stdout.

**Enforcement:** `apps/api/src/projects/git/object-store.test.ts` (commits-only clone, single-file reads, listing without content, search, the byte cap and its memo, the fetch-and-retry net, old whole-history stores replaced, the `full` kill switch, no stdout in error messages), `partial-store-history.test.ts`, `partial-store-diff-cap.test.ts`, `config-releases/partial-store.test.ts`, `git-proxy/project-snapshot-build.test.ts`, `fast-boot-bundle-partial.test.ts`. The fixture is `apps/api/src/projects/git/__tests__/partial-store-fixture.ts`. Kill switch: `KORTIX_GIT_OBJECT_STORE=full`.
