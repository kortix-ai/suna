---
recorded: 2026-09-30T12:28:16Z
incident_date: 2026-09-29
---
# In gateway mode, route every model ref OpenCode reads from the config dir through the kortix provider

**Rule:** In gateway mode the only OpenCode provider is `kortix`, and OpenCode splits a model ref at its first slash. Every model ref OpenCode reads itself (an agent `.md`'s `model:`) must reach it as `kortix/<wire ref>`. The composed `OPENCODE_CONFIG` file cannot fix a `.md`: OpenCode merges the config dir AFTER it. Only `OPENCODE_CONFIG_CONTENT` merges later. Test the prompt that names NO model: the web and triggers always name one, so they hide this.

**Trigger surface:** Composing the OpenCode config in the sandbox daemon (`harness/open-code/lifecycle.ts`), writing an agent `.md` with `model:`, or adding a delivery path that sends a prompt without a model.

**Incident:** From 2026-09-29 17:59Z until the fix, every Slack follow-up to one internal project's default agent failed with "The selected model isn't available". The agent `.md` declared `model: codex/gpt-6-sol`, which OpenCode read as provider `codex` ("Model not found: codex/gpt-6-sol."). 19 of 19 follow-ups got no reply. Web and trigger turns in the same session worked.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/opencode-lifecycle.e2e.test.ts` › "agent .md model refs": the spawn env carries the `kortix/` patch in gateway mode, none in native mode, and a changed `.md` model respawns instead of disposing.
