---
recorded: 2026-10-20T07:21:39Z
incident_date: 2026-10-20
---
# When you change an error message, run every test in the module's directory, not only the tests you wrote

**Rule:** When a change rewords an error message, find every test that pins it before the merge. Run each test file in the changed module's directory and its `__tests__` neighbors (for `apps/api/src/projects/lib/trigger-*.ts`: `src/projects/lib/*trigger*.test.ts`, `src/projects/*trigger*.test.ts`, `src/__tests__/unit-trigger-*.test.ts`). Do not rely on a grep for the old message: a test pins a fragment of it (`'filter keys must be non-empty'`), and a grep for the full sentence misses it.

**Trigger surface:** Moving validation into a shared parser, or rewording any API or validator error string.

**Incident:** 2026-10-20, v0.14.3 release suite. #10312 (trigger filter operators) moved the filter parsing into `@kortix/manifest-schema` and reworded 2 errors. Its pre-merge runs covered the new tests, one API unit file, the triggers flow domain and the touched packages, but not `apps/api/src/projects/lib/trigger-split-characterization.test.ts`, which pinned `filter must be an object` and `filter keys must be non-empty`. That file went red on `dev` and in the release suite; #10337 fixed it forward. No user impact: the change rejected the same inputs.

**Enforcement:** The release suite (`Tests` lanes on a pull request into `staging`) runs every API unit test and caught this one. Nothing catches it before the merge into `dev`, where no CI runs by default. The pre-merge check is the directory-wide run above.
