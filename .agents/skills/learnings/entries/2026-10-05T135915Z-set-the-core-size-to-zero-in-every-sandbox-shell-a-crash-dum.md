---
recorded: 2026-10-05T13:59:15Z
incident_date: 2026-10-04
---
# Set the core size to zero in every sandbox shell: a crash dump carries the agent's whole environment

**Rule:** A sandbox process tree that holds secrets runs with `ulimit -c 0`. The
entrypoint sets it before the privilege drop, and the agent env file that every
shell sources sets it again. Never pipe a tool into `head` and then stage the
whole tree: the pipe can crash the tool, and the crash can write `core` into
the checkout.

**Trigger surface:** changing `apps/sandbox/entrypoint.sh`, the agent env file
(`harness/shared/agent-env-file.ts`), a sandbox provider, or a worker skill that
stages files.

**Incident:** 2026-10-04, commit ef980a9c22 on the public repository. Root cause
chain, reproduced:
1. A factory worker ran `biome check <file> 2>&1 | head`. Biome 1.9.4 writes
   diagnostics to stderr; when `head` closed the pipe, Biome panicked
   (`Result::unwrap()` on `Err(BrokenPipe)`, `crates/biome_console/src/lib.rs:151`)
   and aborted with SIGABRT (exit 134). Evidence: the dump's NT_PRSTATUS
   (signal 6) and the panic text in its memory; reproduced in amd64 Linux and in
   a Company sandbox started with `--no-secrets`.
2. Daytona starts sandboxes with `ulimit -c unlimited` (soft and hard, inherited
   from PID 1). On the worker's host the kernel wrote `core` into the working
   directory, the repository root. Reproduced: with `unlimited`, the Biome abort
   leaves `core` in the checkout; with `ulimit -c 0`, it leaves none.
3. The worker staged the whole tree. No `.gitignore` entry covered `/core`, no
   hook checked for binaries, and GitHub push protection skips binary files.
4. The worker's environment held 74 project secrets because its agent grant is
   `secrets: all`, so the dump held all of them.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/agent-env-file.test.ts`
("disables core dumps in every shell that sources it") goes red when the env
file stops lowering the limit. The commit-side guard is the 2026-10-04 entry
"Never stage a core dump" (`scripts/check-binary-dumps.sh`, `.gitignore`).
