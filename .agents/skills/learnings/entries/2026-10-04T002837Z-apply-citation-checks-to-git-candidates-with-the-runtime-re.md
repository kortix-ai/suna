---
recorded: 2026-10-04T00:28:37Z
incident_date: 2026-10-04
---
# Apply citation checks to Git candidates with the runtime regex engine

**Rule:** Use Git's literal file selection, then check candidate contents with the runtime regex engine. Preserve binary checks and citation boundaries. Do not relax the test deadline.

**Trigger surface:** Repository-wide citation guards under concurrent local test load.

**Incident:** On 2026-10-04, the documentation guard exceeded five seconds during the full gate. A second Git regex scan cost 1.86–2.49 seconds in isolated probes. Emitting whole matching lines exceeded the subprocess output buffer. Checking Git's candidate files with V8 passed the repository scan in 498 milliseconds.

**Enforcement:** `tests/unit/no-docs-tree.test.ts` rejects root, relative, binary, and multiline citations. It permits nested product documentation and external URLs. The five-second deadline remains unchanged.
