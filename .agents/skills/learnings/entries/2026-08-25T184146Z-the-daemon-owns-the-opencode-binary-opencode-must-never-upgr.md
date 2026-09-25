---
recorded: 2026-08-25T18:41:46Z
commit: 952e400c54
---
# The daemon owns the OpenCode binary; OpenCode must never upgrade itself

*Incident (2026-08-22 and again 2026-08-25, SampleCo):* a human ran `opencode`
in the Session terminal. OpenCode's autoupdate (`autoupdate` unset = on)
installed the newer version with plain `pnpm add -g` — no postinstall — leaving
a 479-byte launcher stub, deleting the old global dir and dangling
`/opt/kortix/opencode.current`. The running server survived on a deleted
inode; the next restart booted the stub ("Still waking this session up").

**Rules.**
1. `buildOpencodeConfigContent` always emits `autoupdate: false`; a base
   config cannot turn it back on. The composed Kortix config is never
   `undefined` any more.
2. Version changes reach a box only through the runtime-assets manifest and
   `installOpencodeVersion` (`pnpm add -g --allow-build=opencode-ai`).

*Automation:* `opencode-config-composition.test.ts` — "always disables
OpenCode autoupdate".
