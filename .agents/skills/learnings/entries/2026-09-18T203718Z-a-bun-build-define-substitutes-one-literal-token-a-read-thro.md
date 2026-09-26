---
recorded: 2026-09-18T20:37:18Z
incident_date: 2026-09-18
commit: caeff40cc0
---
# A `bun build --define` substitutes one literal token; a read through an injected `env` object ships `undefined`

**Incident.** The first published `kortix tui` (dev-latest `0.13.25-dev.4589893d`,
merge `4589893d40`) could not install its own TUI binary: `kortix tui --install`
from a clean HOME answered `This kortix reports version "dev", which has no
published release` while `kortix --version` on the same binary printed
`v0.13.25-dev.4589893d`. CI bakes the version with
`--define="process.env.KORTIX_CLI_VERSION=\"${CLI_VERSION}\""`. `src/index.ts`
reads the literal `process.env.KORTIX_CLI_VERSION` and is substituted;
`tui-bin.ts` read `env.KORTIX_CLI_VERSION` through an injected
`env: NodeJS.ProcessEnv = process.env` parameter (a test seam), which the define
does not touch, so the compiled binary read the real environment — unset — and
fell to `'dev'`. Every unit test passed: none ran through the define. Found only
by running the PUBLISHED binary against the PUBLISHED assets from a directory
with no cache (the `~/.kortix/tui/dev/` cache on the dev machine had masked it
in the first check).

**Rule.** Read a build-time define through its literal token, once, at module
scope (`const BAKED = process.env.KORTIX_CLI_VERSION`), and let an injected
`env` matter only when nothing is baked. Any new `--define` gets a test that
builds a real bundle with `bun build --define …` and runs it with the variable
UNSET. And the post-deploy proof for a launcher is the published binary + the
published asset from a clean HOME, never the dev binary beside its dev cache.

**Enforcement.** `apps/cli/src/tui-bin.test.ts` "cliVersion inside a compiled
binary" builds through the define and asserts both `cliVersion({})` and
`cliVersion()` answer the baked value (verified red on the old line).
