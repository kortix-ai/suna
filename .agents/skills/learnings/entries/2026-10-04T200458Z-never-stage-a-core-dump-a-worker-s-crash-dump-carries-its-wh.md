---
recorded: 2026-10-04T20:04:58Z
incident_date: 2026-10-04
---
# Never stage a core dump: a worker's crash dump carries its whole env

**Rule:** Stage files by name. Never `git add -A`, `git add .`, or `git commit -a` in a checkout where a process can crash. A core dump holds the whole process environment, so committing one publishes every secret the process had.

**Trigger surface:** An agent or factory worker commits after a command crashed in the repository directory. The kernel writes `core` (Linux) or `core.<pid>` into the working directory, and a blanket add stages it.

**Incident:** 2026-10-04. A factory worker committed a 60 MB ELF core dump at the repository root of the public repository. It held the worker's environment: deploy keys, vendor API keys, and cloud credentials. GitHub push protection skips binary files, so the push went through. Every credential in the dump was treated as compromised and rotated.

**Enforcement:** `scripts/check-binary-dumps.sh` runs from `.githooks/pre-commit` (staged files) and `.githooks/pre-push` (pushed commits, including `--no-verify` commits). It refuses an ELF or Mach-O core file and any file over 20 MB. `.gitignore` ignores `/core`, `core.[0-9]*`, and `*.core`. `tests/unit/binary-dumps-guard.test.ts` proves both. The **contributing** skill says to stage by name.
