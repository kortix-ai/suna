---
name: whisper
description: "Transcribe any audio or video file to text using Whisper (Groq or OpenAI). Use when the agent receives voice messages, audio files, video messages, or any media with speech. Triggers on: 'transcribe', 'what does this say', 'voice message', 'speech to text', 'audio', any file path ending in .ogg .mp3 .mp4 .wav .webm .m4a .flac .oga .oga"
---

# Whisper — Audio/Video Transcription

Transcribe any audio or video file to text. Uses Groq Whisper (fastest, near-instant) with OpenAI fallback.

## Usage

```bash
kwhisper --file /path/to/audio.ogg
kwhisper --file /workspace/telegram-files/voice.oga
kwhisper --file /workspace/slack-files/audio.mp3 --language en
kwhisper --file /workspace/meeting.mp4 --timestamps
```

## Output

```json
{"ok": true, "text": "The transcribed text...", "provider": "groq", "language": "en", "duration": 12.5}
```

## Flags

| Flag | Description |
|------|-------------|
| `--file` | Path to audio/video file (required) |
| `--language` | ISO-639-1 code (en, de, es) — optional, auto-detected |
| `--timestamps` | Include segment-level timestamps |
| `--prompt` | Hint text to guide transcription |

## Supported Formats

mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, oga, flac

## When to Use

- Voice message received → transcribe first, then respond to content
- Video note (round video) → transcribe audio
- Any video/audio file → transcribe to understand speech
- Meeting recordings → extract text

## Auth

Requires `GROQ_API_KEY` (preferred — near-instant) or `OPENAI_API_KEY`.
