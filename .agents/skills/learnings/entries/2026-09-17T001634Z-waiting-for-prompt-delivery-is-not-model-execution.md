---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-16
commit: cea48e1b66
---
# Waiting for prompt delivery is not model execution

**Incident.** Waiting inbox rows and reserved delivery turns rendered Thinking before the runtime received a prompt. Two cancel consumers stamped timeouts as acknowledgements. Older failed rows still exposed internal delivery outcome labels.

**Rule.** Preserve a separate pending-delivery projection while keeping Stop available. Only an active turn or runtime activity can claim an agent response. A timeout or skipped cancel cannot acknowledge Stop. Apply the abort acknowledgement boundary to stream activity, busy frames, and inbox reads as well as turn reads. Stopping queued work cannot mark an already completed answer interrupted. Render the actual failure cause, including legacy persisted rows.

**Enforcement.** SDK working-projection and abort-receipt tests cover delivery, active turns, and timeout settlement. Prompt serializer tests cover legacy failures. Browser journey 27 checks no Thinking while queued or booting, persistent Stop holds, and reload.
