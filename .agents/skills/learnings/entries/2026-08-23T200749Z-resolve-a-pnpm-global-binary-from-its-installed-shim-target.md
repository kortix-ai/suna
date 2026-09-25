---
recorded: 2026-08-23T20:07:49Z
commit: e9bc1b7e79
---
# Resolve a pnpm global binary from its installed shim target

2026-08-23. `pnpm root -g` failed under pnpm 11.15.1 after a successful global
install. `PNPM_HOME` and pnpm's configured global-bin directory resolved to
different paths. The generated `opencode` shim still executed version 1.18.19,
but the following package-root lookup exited non-zero.

**The rule.** Runtime image builds must not infer pnpm's versioned global-store
layout. When a native binary must outlive its package-manager shim, read the
installed shim's `cmd-shim-target` metadata and validate that exact target.

**The enforcement.** The canonical, layer, fast, and meta Dockerfile tests pin
`cmd-shim-target` resolution. They reject both `pnpm root -g` and the older
`pnpm list -g` lookup.

*Incident:* the live E2B build installed OpenCode 1.18.19 and printed its
version, then failed before the native-binary assertion.
