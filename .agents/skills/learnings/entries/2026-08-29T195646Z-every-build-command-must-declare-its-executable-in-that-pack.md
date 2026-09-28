---
recorded: 2026-08-29T19:56:46Z
commit: 203c02b6cb
---
# Every build command must declare its executable in that package

- **Incident (2026-08-29, v0.13.8 production release):** the
  `@kortix/llm-catalog` publish job ran `tsc-alias` from its `build` script, but
  the package did not declare `tsc-alias`. Local builds found the executable
  through `@kortix/sdk`. The isolated production publish runner returned exit
  `127`. The workflow then skipped the dependent `@kortix/sdk` publish.
- **Rule:** each publishable package must directly declare every executable in
  its lifecycle scripts. A sibling package dependency does not satisfy this
  requirement.
- **Enforcement:** `packages/llm-catalog/package.json` declares `tsc-alias` in
  `devDependencies`. The package build now resolves the executable through its
  own `node_modules/.bin` directory.
