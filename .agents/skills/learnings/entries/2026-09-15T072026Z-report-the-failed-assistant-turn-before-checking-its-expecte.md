---
recorded: 2026-09-15T07:20:26Z
incident_date: 2026-09-15
commit: c22035d0b3
---
# Report the failed assistant turn before checking its expected file

**When:** a real-agent flow waits for OpenCode messages and then reads a written file. If the assistant message contains `info.error`, raise its message before a file read. *Near-miss:* v0.13.15 preview `GOLD-1` reported only a file 404 after the turn had already failed with `ZstdDecompressionError`. *Enforcer:* `waitForAssistantOutput` in `tests/src/flows/run-session-backlog.flow.ts` surfaces the assistant error.
