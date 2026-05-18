# @kortix/executor-bridge

This package is the only Kortix-owned boundary that should know about the
vendored Executor checkout at `vendor/executor`.

Do not import files from `vendor/executor` directly in `apps/api` or `apps/web`.
Wire runtime behavior here first, then expose a small Kortix-facing API.

Current scope:

- Keep the upstream Executor checkout pinned and discoverable.
- Describe the public Executor package boundaries Kortix is allowed to depend on.
- Avoid database, route, or UI side effects until the bridge has a proven runtime path.

