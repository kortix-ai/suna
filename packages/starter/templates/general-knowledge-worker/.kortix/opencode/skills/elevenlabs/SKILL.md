---
name: elevenlabs
description: "ElevenLabs audio generation — text-to-speech, voice cloning, and sound effects. Use this skill any time the agent needs to: convert text to spoken audio, narrate documents or content, generate voiceovers, clone voices from audio samples, create sound effects, or produce any audio output from text. Supports multiple voices, languages, models, voice cloning, batch processing, and sound effect generation. Requires ELEVENLABS_API_KEY."
---

# ElevenLabs — Text-to-Speech, Voice Cloning & Sound Effects

ElevenLabs-powered audio generation. Convert any text to natural-sounding speech, clone voices, generate sound effects.

---

## Setup

**Required env var:** `ELEVENLABS_API_KEY`

The CLI script at `scripts/tts.py` uses only Python stdlib (`urllib`, `json`, `argparse`) — no pip dependencies needed.

---

## Quick Reference

All commands use the CLI script:

```bash
python skills/elevenlabs/scripts/tts.py <command> [args]
```

### Speak — Convert text to speech

```bash
# Basic — default voice (George), multilingual v2 model
python scripts/tts.py speak "Hello, this is Kortix speaking."

# Named voice
python scripts/tts.py speak "Welcome to the presentation." --voice Rachel

# Custom output file
python scripts/tts.py speak "Chapter one." --voice George -o chapter1.mp3

# From a file (prefix with @)
python scripts/tts.py speak @article.txt -o narration.mp3

# From stdin
echo "Dynamic text" | python scripts/tts.py speak -

# With voice tuning
python scripts/tts.py speak "Dramatic reading." --voice Rachel --stability 0.3 --similarity 0.9 --style 0.7

# High quality output
python scripts/tts.py speak "Studio quality." --format mp3_44100_192

# Different model (faster, English-only)
python scripts/tts.py speak "Quick response." --model eleven_turbo_v2_5

# Speed control
python scripts/tts.py speak "Slowly now." --speed 0.7
python scripts/tts.py speak "Fast paced!" --speed 1.5
```

### Voices — List and search

```bash
# List all available voices
python scripts/tts.py voices

# Search by name, gender, accent, or use case
python scripts/tts.py voices --search "female"
python scripts/tts.py voices --search "british"
python scripts/tts.py voices --search "narration"
```

### Models — List available TTS models

```bash
python scripts/tts.py models
```

### Clone — Create a custom voice from audio samples

```bash
# Clone from audio files (1-25 samples, each 1-10 minutes)
python scripts/tts.py clone "ClientVoice" sample1.mp3 sample2.mp3

# With description
python scripts/tts.py clone "CEO" ceo_speech.mp3 --description "Confident male voice, American accent"

# Use the cloned voice
python scripts/tts.py speak "Hello from my cloned voice." --voice-id <returned_voice_id>
```

### Batch — Convert entire documents

```bash
# Convert a text file to a single audio file
python scripts/tts.py batch article.txt -o article_audio/

# Split by paragraphs — one audio file per paragraph
python scripts/tts.py batch book_chapter.txt --split-paragraphs -o chapter_audio/

# With specific voice
python scripts/tts.py batch script.txt --voice Rachel --split-paragraphs
```

### Sound Effects — Generate from text prompts

```bash
# Generate a sound effect
python scripts/tts.py sound "ocean waves crashing on a beach"

# With specific output and duration
python scripts/tts.py sound "thunderstorm with heavy rain" -o thunder.mp3 --duration 10.0
```

---

## Voice Settings Guide

Fine-tune voice output with these parameters:

| Parameter | Range | Default | Effect |
|---|---|---|---|
| `--stability` | 0.0 - 1.0 | 0.5 | Higher = more consistent, lower = more expressive/varied |
| `--similarity` | 0.0 - 1.0 | 0.75 | Higher = closer to original voice, lower = more creative |
| `--style` | 0.0 - 1.0 | 0.0 | Higher = more expressive style, can reduce stability |
| `--speed` | 0.5 - 2.0 | 1.0 | Playback speed multiplier |

**Recommended presets:**

- **Narration/Audiobook:** `--stability 0.5 --similarity 0.75` (balanced, natural)
- **News/Formal:** `--stability 0.8 --similarity 0.8` (consistent, clear)
- **Character/Dramatic:** `--stability 0.3 --similarity 0.8 --style 0.7` (expressive, varied)
- **Conversational:** `--stability 0.4 --similarity 0.6` (natural variation)

---

## Output Formats

| Format | Quality | Size | Use Case |
|---|---|---|---|
| `mp3_44100_128` | High (default) | Medium | General purpose, good quality |
| `mp3_44100_192` | Very high | Large | Studio quality, archival |
| `mp3_22050_32` | Low | Small | Voice messages, previews |
| `pcm_44100` | Lossless | Very large | Post-processing, editing |
| `pcm_16000` | Lossless low | Large | Speech recognition input |
| `opus_48000_128` | High | Small | Web streaming, efficient |

---

## Models

| Model | Speed | Quality | Languages | Best For |
|---|---|---|---|---|
| `eleven_multilingual_v2` | Normal | Highest | 29 languages | Default — best quality, multilingual |
| `eleven_turbo_v2_5` | Fast | High | 32 languages | Low-latency, near-instant generation |
| `eleven_monolingual_v1` | Normal | Good | English only | Legacy English-only workloads |

Always use `eleven_multilingual_v2` unless speed is critical (then use `eleven_turbo_v2_5`).

---

## Common Workflows

### Narrate a document

```bash
# Read the document, generate speech
python scripts/tts.py speak @workspace/report.md --voice Rachel -o report_narration.mp3
```

### Create a podcast intro

```bash
python scripts/tts.py speak "Welcome to the Kortix Weekly. I'm your host, and today we're diving into autonomous AI agents." \
  --voice George --stability 0.4 --similarity 0.8 --style 0.5 \
  -o podcast_intro.mp3
```

### Narrate a presentation (per-slide)

For each slide, generate a separate audio file:
```bash
python scripts/tts.py speak "Slide 1: Introduction to our company" --voice Rachel -o slides/01.mp3
python scripts/tts.py speak "Slide 2: Our key metrics this quarter" --voice Rachel -o slides/02.mp3
```

Or write all narration to a text file (one paragraph per slide) and batch it:
```bash
python scripts/tts.py batch slide_notes.txt --split-paragraphs --voice Rachel -o slide_audio/
```

### Voice clone for personalization

```bash
# Clone the user's voice from samples they provide
python scripts/tts.py clone "UserVoice" sample1.mp3 sample2.mp3 sample3.mp3 \
  --description "The user's natural speaking voice"

# Use it for all future TTS
python scripts/tts.py speak "Personalized message." --voice-id <voice_id> -o message.mp3
```

### Generate ambient audio

```bash
python scripts/tts.py sound "coffee shop ambiance with gentle chatter" -o ambient.mp3 --duration 15
python scripts/tts.py sound "gentle rain on a window" -o rain.mp3 --duration 30
```

---

## Integration Notes

- **No pip dependencies.** The script uses only Python stdlib (`urllib.request`, `json`, `argparse`). Works on any Python 3.10+ installation.
- **Output files** are saved relative to the current working directory. Use `-o` to specify exact paths.
- **Long text** is handled automatically by the API. For very long documents (>5000 chars), consider using `batch` with `--split-paragraphs` for better quality and to avoid timeouts.
- **Rate limits** apply per your ElevenLabs plan. The script will return API errors if limits are hit.
- **Character usage** counts against your ElevenLabs monthly quota. Check your plan's limits.

---

## Env Vars

| Variable | Required | Description |
|---|---|---|
| `ELEVENLABS_API_KEY` | Yes | Your ElevenLabs API key (also accepts `ELEVEN_API_KEY`) |

Add to `core/docker/.env` (or the active OpenCode config dir `.env` during local materialization):
```
ELEVENLABS_API_KEY=your_key_here
```
