---
recorded: 2026-10-01T12:36:59Z
incident_date: 2026-10-01
---
# Send the session's model with every channel prompt; a prompt without one runs on the runtime's last model, not the pin

**Rule:** Every prompt a channel (Teams, Slack) sends to a session carries a model: the conversation's `/model` choice, else the session's pin, else a servable replacement. `channelTurnModel` (`apps/api/src/services/channels/vision-model.ts`) returns `null` only when there is nothing servable to send.

Never skip the model because it "has not changed". With no model on the prompt, OpenCode answers on the model of the session's last prompt. That model is neither the pin in `metadata.opencode_model` nor the model the web composer shows.

**Trigger surface:** `channels/vision-model.ts` (`channelTurnModel`), `channels/model-access.ts` (`planChannelFollowUp`, `planChannelSessionStart`), the Teams and Slack follow-up paths, and any new path that prompts an existing session without the web composer.

**Incident:** 2026-10-01, found in a live Teams test on dev. A Teams channel session was pinned to `kortix/deepseek-v4.1-flash`, and the channel's `/model` was DeepSeek too. Yet every turn from 2026-09-24 14:21Z ran on `codex/gpt-6-astra`, per `session_transcript_messages.info.model`. One earlier prompt had carried that model, and each later follow-up sent none. Each failed with "Connect Codex to use this model", while the web composer showed DeepSeek.

`channelTurnModel` sent a model only for an image or an explicit `/model` change (`explicit`). Its own comment had recorded the stale-runtime-model hazard for images on 2026-09-21. Fixed in PR #8618.

**Enforcement:**
- `apps/api/src/__tests__/unit-channel-vision-model.test.ts` → "a plain text message carries its healthy pin, so the runtime cannot answer on a stale model".
- `unit-channel-model-access.test.ts` → "with no choice, or the same one, the follow-up carries the session's pin".
