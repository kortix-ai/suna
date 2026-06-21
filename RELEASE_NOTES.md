Full cron coverage + correct stall detection

Follow-up reliability fix: removes a too-aggressive internal sweep timeout that could under-cover scheduled triggers at scale, and corrects a false scheduler-stalled health signal. More consistent on-time trigger firing; no other user-facing change.
