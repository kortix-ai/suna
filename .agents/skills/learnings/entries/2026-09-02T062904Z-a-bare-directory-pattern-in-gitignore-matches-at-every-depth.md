---
recorded: 2026-09-02T06:29:04Z
incident_date: 2026-09-02
commit: 424851706b
---
# A bare directory pattern in .gitignore matches at EVERY depth, and a test that reads the working tree cannot see what was never committed

**When:** adding product content under a directory name that also appears in
`.gitignore` — starter templates, fixtures, scaffolds, vendored config. Root
`.gitignore` carried `.kortix/` with no leading slash, written to drop the
repo's own dogfood project. Git applies such a pattern at ANY depth, so it also
matched `packages/starter/templates/pi/.kortix/` — the scaffold every new pi
project is built from. `git add` reported nothing, the commit went in without
the files, and the branch shipped a pi template of four files: a manifest
declaring `default_agent: kortix` whose agent markdown did not exist, and no
`.kortix/pi/` for `kortix init` to link into, so all six of its symlinks
dangled. `templates/base/` predated the rule and stayed tracked, which is why
only the NEW template was hit.
**The reason it survived review:** `pi-template.test.ts` and
`pi-starter-compiles.test.ts` both assert exactly the missing files
(`map.has('.kortix/pi/agents/kortix.md')`, body > 200 chars) and both PASSED
locally — they read the working tree, where the ignored files sat on disk. A
green local suite says nothing about what is in the commit. Reproducing the
committed state by moving the two files aside turned 12 pass into 3 fail.
**Rules:** (1) anchor an ignore meant for the repo root with a leading slash
(`/.kortix/`), or pair the broad rule with an explicit
`!packages/**/templates/*/.kortix/` re-include; (2) after adding files under
any name that appears in `.gitignore`, run `git status --ignored` or
`git check-ignore -v <path>` before trusting a silent `git add`; (3) verify a
packaging change from a FRESH CLONE, never from the working tree that authored
it — `git ls-files <dir>` is the cheap version of that check.
**Diagnostic:** product files present on disk, absent from `git ls-files`, and
a scaffold whose file count is smaller than the template's directory listing.
*Near-miss:* caught on the pi-worker branch before it reached main or any user;
every `kortix init` on the pi template would have produced an agent-less project.
*Enforcer:* the two tests above are correct and now run against committed
content; the `!packages/starter/templates/*/.kortix/` re-include is what keeps
them honest.
