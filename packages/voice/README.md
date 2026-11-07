# @kortix/voice

Voice calls with a session's own agent. You talk, and the agent hears you, answers in a voice, sees a screen you share, and works in the same session. The conversation is the session's chat.

## How it loads

The project flag `voice_call` turns it on (Settings → Feature flags). kortixd then registers the built-in `kortix-voice` extension for each top-level session (`apps/kortix-sandbox-agent-server/src/harness/pi/extensions/voice.ts`). That extension imports this package and calls `attach(pi, sessionId)` (`src/kortix.ts`):

- **One relay per box**, on `KORTIX_VOICE_PORT` (default `6902`, next to the desktop's `6901`). It starts with the first session.
- **Each session binds under its Kortix session id.** A call names it: `/stream?session=<id>`. The call's turns are that session's own turns (`src/agents/pi.ts`): no HTTP hop to the agent, and no second transcript.
- **Meta tools** (`voice_state`, `voice_say`, `voice_set`, `voice_later`, `voice_watch`, `voice_cancel`, `voice_capture`, `voice_look`) let the agent read and act on its own live call (`src/voice-tools.ts`).
- **Speech tools**, with or without a call: `voice_speak` says text in the agent's call voice into an audio file (mp3 or wav), and `voice_transcribe` turns an audio file into text. With them the agent can send its voice to any API that takes audio, and hear a channel's voice note (`src/speech-api.ts`, the relay's `POST /speech`).
- **Meetings and web calls.** `voice_join_meet` joins a Google Meet as a guest (`src/meet/join.ts`). It hears everyone through Meet's live captions, with their names, and only the people named in `trusted` may ask the agent to act. `voice_join_call` opens any other web call (`src/meet/call.ts`) in a call browser of the voice's own. The agent joins it with its own browser tool over that browser's CDP port. The voice is the page's microphone and hears the page's remote WebRTC audio. No names come with that audio, so nobody heard may ask the agent to act unless the owner says `trusted: true`. `voice_leave_meet` leaves either one.

With the flag off, nothing here is imported and no port opens.

## The call, from the browser

The web app reaches the relay through the sandbox port proxy: `wss://<api>/v1/p/<sandbox>/6902/stream?session=<id>&token=<jwt>`.

| Direction | Message |
| --- | --- |
| relay → browser | `{"type":"ready","inRate":16000,"outRate":24000,"session":…}`: the audio rates, once the call is set up |
| browser → relay | binary: 16-bit mono PCM at `inRate` (the microphone) |
| browser → relay | `{"type":"image","data":"<jpeg base64>","from":"screen"}`: a shared-screen frame when it changes; `"data":""` when sharing stops |
| browser → relay | `{"type":"text","text":"…"}`: a typed turn; `{"type":"persona","name":…,"voice":…}`: who the voice is |
| relay → browser | binary: 16-bit mono PCM at `outRate` (the voice) |
| relay → browser | `{"type":"text","role","who","text"}`: a line of the call, said or heard |
| relay → browser | `clear` (drop what is queued: they talked over it), `duck`/`hold` `{on}` (lower or pause playback), `listen`, `tool`, `event` `{kind,…}`, `closed` |

`GET /health` answers `{ok, calls}`. `GET`/`POST /call?session=<id>` reads or acts on a live call: the same actions the meta tools take.

## Models

Every model call goes through the box's LLM proxy to Kortix's LLM gateway (`VOICE_MODELS_URL`, set by `attach`). Searches go through the API's billed router (`/v1/router/{serper,tavily,firecrawl}`) with the session token. These are the Platinum private models the gateway serves:

| Use | Model |
| --- | --- |
| speech-to-text | `whisper-large-v3`, `whisper-large-v3-turbo` |
| end of turn, quick answers | `qwen3.8-27b` |
| routing a turn | `gpt-oss-20b` |
| the voice | `inworld-tts-2` (`INWORLD_MODEL`), voice `INWORLD_VOICE` |
| reading a shared screen | `gemini-3.5-flash-lite` |

Everything else, such as deeper work and tools, is the session's own agent and model.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `KORTIX_VOICE_PORT` | `6902` | the box relay's port |
| `VOICE_MODELS_URL` | the box's LLM proxy | where every model call goes |
| `INWORLD_VOICE` | `Ashley` | the voice |
| `VOICE_NAME` | `Kortix` | the name the voice answers to |
| `VOICE_TTS` | `models` in a box | `mock` for tests: a hum, no characters spent |
