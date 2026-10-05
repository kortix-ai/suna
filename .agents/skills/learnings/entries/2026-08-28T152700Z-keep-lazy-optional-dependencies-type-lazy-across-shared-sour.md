---
recorded: 2026-08-28T15:27:00Z
incident_date: 2026-08-28
commit: 5498bbbf8e
---
# Keep lazy optional dependencies type-lazy across shared-source imports

**When:** a package imports source files from another package without installing
that package's runtime dependencies. Do not use a static type import for an
optional dependency. Define the required structural type locally, and keep the
runtime import behind the existing lazy boundary.
*Near-miss:* staging promotion PR #7027 failed because the sandbox agent typecheck
resolved the worker's `import('ws')` type without installing worker dependencies.
*Enforcer:* the Sandbox Agent CI job runs `bun run typecheck` before its build.
