---
recorded: 2026-08-26T00:19:20Z
commit: 680cea8c4a
---
# Image bytes never live in the transcript; memory is guarded before the kernel; an unknown probe backs off

*Incident (2026-08-25 23:12Z, SampleCo session 9df2a873):* the kernel OOM-killed
OpenCode at 6.48 GB RSS on an 8 GB box (`dmesg`: `Killed process 1506
(opencode.exe) anon-rss:6484532kB`), mid-turn, leaving an empty assistant
husk. Two forces met: the transcript held 275 MB of base64 tool screenshots in
`part.state.attachments[].url` (352 of 538 tool parts) which every LLM step
and every list re-serialised, and the reaper re-probed the box 345 times in
one hour after `unknown` (two replicas, 20 s cadence), each probe forcing a
full-transcript serialisation. OpenCode's own compaction clears old tool
output text and stops SENDING old attachments, but never removes bytes from
storage (`session/compaction.ts`, `message-v2.ts`); there is no native
"store a path instead" for tool attachments (`tool/read.ts` writes `data:`).

**Rules.**
1. `attachment-offload.ts` (daemon): when idle, attachments older than the
   newest 12 per session (and every one OpenCode marked `compacted`) move
   to `~/.local/share/kortix/attachments/<id>`; the row keeps a 1×1 PNG
   `data:` placeholder (valid for OpenCode's model conversion, the AI SDK,
   the media-extraction path) plus `kortix:{offloaded,sidecar,bytes,mime}`.
   Optimistic UPDATE on `time_updated`; never the newest message; never
   during a turn. Verified on 1.18.23: OpenCode serves the rewritten row on
   the next read (7 ms UPDATE, no restart). `/kortix/part` serves sidecar
   bytes and searches nested `state.attachments` (tool screenshots 404'd
   before).
2. Memory guard (`resources.ts`): ≥80 % box/cgroup memory → 10 s sampling;
   ≥92 % with a turn in flight → `POST /session/:id/abort`, turn-stream
   `kind:end status:error error_name:SandboxMemoryGuard` with the numbers,
   then an offload pass. One action per crossing; re-armed below 80 %.
   `KORTIX_MEMORY_GUARD_PCT` overrides.
3. Reaper (`box-reaper.ts`): an `unknown` observation backs the PROBE off
   per sandbox (20 s → 5 min, per replica); the drip still extends.
   `probeBackoff` clears on the first readable answer.

*Automation:* `attachment-offload.test.ts` (real bun:sqlite fixture in the
1.18.23 row shape, optimistic-skip race), `part-route-attachments.test.ts`,
`resources.test.ts` ("memory guard"), `sandbox-reaper.test.ts` ("not
re-probed until its back-off elapses").
