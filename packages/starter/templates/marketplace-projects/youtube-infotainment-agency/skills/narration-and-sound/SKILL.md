---
name: narration-and-sound
description: Produce narration (TTS per beat → locked timing.json), the music score and SFX, and the mix inputs (sound.json). Load for the voice stage, the sound stage, re-voicing after script changes, or any audio problem.
---

# Narration & sound (stages: voice, sound)

Read `channel/audio.md` first.

## Casting — this episode's narrator (first step of every voice stage)
There is no channel-wide voice: each episode gets the narrator
that fits it, chosen by you, with no human gate. The rule that bounds the choice lives in
`channel/channel.yaml → voice.casting` (language, Voice Library use case, sort, model — Eleven v4).
1. `bin/yt cast library <slug>` — writes `03-script/voice-candidates.json`: eligible Voice Library
   narrators, most-used first, plus every excluded voice with the reason (custom rate, no notice period,
   not verified on the model).
2. Choose. Read the script's `voice_direction`, the topic and the tone of the hook and climax, then the
   candidates' gender, age, accent, descriptive and description. Pick the voice whose register fits this
   story. You can't hear them: judge by that metadata, prefer widely used voices when two fit equally,
   and confirm with `bin/yt voice report` after narrating.
3. `bin/yt cast adopt <slug> <voice_id> --by sound-editor --reason "<why this voice fits this episode>"` —
   writes `03-script/voice.json`; `bin/yt voice` reads it. Commit it with the narration's timing.
A re-voice keeps the episode's cast unless the showrunner asks for a re-cast. Never edit `voice.json` by hand.

## Voice stage — lock the timing
```bash
bin/yt voice <slug>                       # provider from channel.yaml (elevenlabs); cached per beat
bin/yt voice <slug> --provider kokoro     # free local draft voice
```
- Each beat is synthesised separately (ElevenLabs `with-timestamps` → word timings) and laid end to
  end with `pause_after` (default 0.35 s). Output: `media/narration/<beat>.wav` + `03-script/timing.json`.
- You cannot hear the narration, so measure it:
  - `bin/yt voice report <slug>` — wpm per beat and the silence after every sentence end, ellipsis and
    clause mark (comma, colon, dash), plus the air between beats. Narration that "runs together" shows
    as clause and sentence pauses near zero; a natural read breathes at sentence ends and idea turns.
  - `ffmpeg -i media/narration/b01.wav -af ebur128 -f null -` for level.
  - Word timings for mispronunciations (numbers, names, units).
- Fix delivery by editing narration text — never by post-processing audio. Only changed beats re-generate.
  Eleven v3/v4 ignore SSML `<break>`; pauses come from the text (`channel/audio.md → Pauses`): an
  ellipsis for a held beat, `[short pause]` / `[long pause]` at idea boundaries, a full stop instead of a
  comma, shorter sentences, and `pause_after` for air after a beat. Spell out numbers or names phonetically.
  Re-run `bin/yt voice` + `bin/yt voice report` until the pauses land where the meaning turns.
- After any re-voice: `bin/yt scene retime <slug>` and tell the showrunner which scenes need re-checking.

## Sound stage — score + effects
Write `06-sound/sound.json` (schema `Sound`):
```json
{ "music": [
  { "id": "m01", "prompt": "curious and playful, felt piano and celesta, 90 bpm, sparse then building, instrumental, no vocals",
    "from_beat": "b01", "to_beat": "b06", "volume": 0.25 },
  { "id": "m02", "prompt": "…climax…", "from_beat": "b07", "to_beat": "b14", "volume": 0.28 } ] }
```
- One cue per act, each ≤ 300 s; boundaries on act changes; the climax cue is the fullest.
- SFX live in the storyboard (`scenes[].sfx`) — review them with the art director's intent.
- Generate: `bin/yt sound <slug>` (cached; only changed prompts re-generate).
- The mix happens in `bin/yt render`: voice at unity, music ducked by side-chain, SFX placed on cue
  words, two-pass loudnorm to −14 LUFS / −1.5 dBTP. Check `qa/render.json` loudness afterwards.

## Quality bar
Voice always intelligible over music; no SFX under key sentences; music arc follows the story arc.
