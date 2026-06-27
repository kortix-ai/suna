#!/usr/bin/env python3
"""
Kortix TTS — ElevenLabs Text-to-Speech CLI

Usage:
  python tts.py speak "Hello world"                          # Speak with default voice
  python tts.py speak "Hello world" --voice Rachel           # Speak with named voice
  python tts.py speak "Hello world" --voice-id JBFqnC...    # Speak with voice ID
  python tts.py speak "Hello world" -o output.mp3            # Save to specific file
  python tts.py speak "Hello world" --model eleven_turbo_v2_5  # Use specific model
  python tts.py speak "Hello world" --format mp3_44100_192   # High quality output
  python tts.py speak "Hello world" --stability 0.8 --similarity 0.9  # Custom settings

  python tts.py voices                                       # List all available voices
  python tts.py voices --search "deep male"                  # Search voices
  python tts.py models                                       # List available models

  python tts.py clone "MyVoice" sample1.mp3 sample2.mp3      # Clone a voice from samples
  python tts.py clone "MyVoice" sample1.mp3 --description "A warm male voice"

  python tts.py batch input.txt -o output_dir/               # Convert text file to speech
  python tts.py batch input.txt --split-paragraphs           # Split by paragraphs, one file each

  python tts.py sound "ocean waves crashing"                 # Generate sound effect
  python tts.py sound "thunder rumble" -o thunder.mp3        # Sound effect to file

Env: ELEVENLABS_API_KEY (required)
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

API_BASE = "https://api.elevenlabs.io/v1"


def get_api_key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVEN_API_KEY")
    if not key:
        print("ERROR: ELEVENLABS_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)
    return key


def api_request(method: str, path: str, body: dict | None = None, stream: bool = False) -> bytes | dict:
    """Make an API request to ElevenLabs."""
    key = get_api_key()
    url = f"{API_BASE}{path}"
    headers = {
        "xi-api-key": key,
        "Content-Type": "application/json",
    }

    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            if stream:
                return resp.read()
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        try:
            error_json = json.loads(error_body)
            detail = error_json.get("detail", {})
            if isinstance(detail, dict):
                msg = detail.get("message", error_body)
            else:
                msg = str(detail)
        except Exception:
            msg = error_body
        print(f"ERROR [{e.code}]: {msg}", file=sys.stderr)
        sys.exit(1)


# ── Commands ─────────────────────────────────────────────────────────────────


def cmd_voices(args: argparse.Namespace) -> None:
    """List available voices."""
    resp = api_request("GET", "/voices")
    voices = resp.get("voices", [])

    if args.search:
        query = args.search.lower()
        voices = [v for v in voices if
                  query in v.get("name", "").lower() or
                  query in (v.get("description") or "").lower() or
                  query in (v.get("labels", {}).get("accent", "") or "").lower() or
                  query in (v.get("labels", {}).get("gender", "") or "").lower() or
                  query in (v.get("labels", {}).get("use_case", "") or "").lower()]

    if not voices:
        print("No voices found.")
        return

    print(f"{'Name':<25} {'ID':<25} {'Gender':<10} {'Accent':<15} {'Use Case':<15}")
    print("-" * 90)
    for v in voices:
        labels = v.get("labels", {})
        print(f"{v['name']:<25} {v['voice_id']:<25} {labels.get('gender', '-'):<10} "
              f"{labels.get('accent', '-'):<15} {labels.get('use_case', '-'):<15}")

    print(f"\nTotal: {len(voices)} voices")


def cmd_models(args: argparse.Namespace) -> None:
    """List available models."""
    resp = api_request("GET", "/models")
    models = resp if isinstance(resp, list) else resp.get("models", resp)

    print(f"{'Model ID':<35} {'Name':<35} {'Languages':<10}")
    print("-" * 80)
    for m in models:
        if not m.get("can_do_text_to_speech", True):
            continue
        langs = len(m.get("languages", []))
        print(f"{m['model_id']:<35} {m['name']:<35} {langs:<10}")


def resolve_voice_id(voice_name: str) -> str:
    """Resolve a voice name to a voice ID. If already an ID, return as-is."""
    # If it looks like a voice ID (long alphanumeric), return directly
    if len(voice_name) > 15 and voice_name.isalnum():
        return voice_name

    resp = api_request("GET", "/voices")
    voices = resp.get("voices", [])
    for v in voices:
        if v["name"].lower() == voice_name.lower():
            return v["voice_id"]

    # Fuzzy match
    for v in voices:
        if voice_name.lower() in v["name"].lower():
            print(f"Matched voice: {v['name']} ({v['voice_id']})", file=sys.stderr)
            return v["voice_id"]

    print(f"ERROR: Voice '{voice_name}' not found. Run 'tts.py voices' to list available voices.", file=sys.stderr)
    sys.exit(1)


def cmd_speak(args: argparse.Namespace) -> None:
    """Convert text to speech."""
    text = args.text

    # Read from stdin if text is "-"
    if text == "-":
        text = sys.stdin.read().strip()
    # Read from file if text starts with @
    elif text.startswith("@"):
        filepath = text[1:]
        text = Path(filepath).read_text(encoding="utf-8").strip()

    if not text:
        print("ERROR: No text provided", file=sys.stderr)
        sys.exit(1)

    # Resolve voice
    if args.voice_id:
        voice_id = args.voice_id
    elif args.voice:
        voice_id = resolve_voice_id(args.voice)
    else:
        voice_id = "JBFqnCBsd6RMkjVDRZzb"  # Default: George

    # Build request body
    body: dict = {
        "text": text,
        "model_id": args.model or "eleven_multilingual_v2",
    }

    voice_settings: dict = {}
    if args.stability is not None:
        voice_settings["stability"] = args.stability
    if args.similarity is not None:
        voice_settings["similarity_boost"] = args.similarity
    if args.style is not None:
        voice_settings["style"] = args.style
    if args.speed is not None:
        voice_settings["speed"] = args.speed
    if voice_settings:
        body["voice_settings"] = voice_settings

    # Output format
    fmt = args.format or "mp3_44100_128"

    # Make the request
    audio = api_request("POST", f"/text-to-speech/{voice_id}?output_format={fmt}", body=body, stream=True)

    # Determine output path
    if args.output:
        out_path = Path(args.output)
    else:
        ext = fmt.split("_")[0]  # mp3, pcm, opus, etc
        out_path = Path(f"speech_output.{ext}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(audio)
    print(f"Audio saved: {out_path} ({len(audio):,} bytes)")


def cmd_batch(args: argparse.Namespace) -> None:
    """Convert a text file to speech, optionally splitting by paragraphs."""
    input_path = Path(args.input_file)
    if not input_path.exists():
        print(f"ERROR: File not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    text = input_path.read_text(encoding="utf-8").strip()

    if args.split_paragraphs:
        chunks = [p.strip() for p in text.split("\n\n") if p.strip()]
    else:
        chunks = [text]

    # Output directory
    if args.output:
        out_dir = Path(args.output)
    else:
        out_dir = Path(f"{input_path.stem}_audio")
    out_dir.mkdir(parents=True, exist_ok=True)

    # Resolve voice
    if args.voice_id:
        voice_id = args.voice_id
    elif args.voice:
        voice_id = resolve_voice_id(args.voice)
    else:
        voice_id = "JBFqnCBsd6RMkjVDRZzb"

    fmt = args.format or "mp3_44100_128"
    ext = fmt.split("_")[0]
    model = args.model or "eleven_multilingual_v2"

    print(f"Converting {len(chunks)} chunk(s) to speech...")
    for i, chunk in enumerate(chunks, 1):
        body = {"text": chunk, "model_id": model}
        audio = api_request("POST", f"/text-to-speech/{voice_id}?output_format={fmt}", body=body, stream=True)
        out_path = out_dir / f"{i:03d}.{ext}"
        out_path.write_bytes(audio)
        print(f"  [{i}/{len(chunks)}] {out_path} ({len(audio):,} bytes) — {chunk[:60]}...")

    print(f"\nDone. {len(chunks)} audio files saved to: {out_dir}/")


def cmd_clone(args: argparse.Namespace) -> None:
    """Clone a voice from audio samples."""
    key = get_api_key()
    url = f"{API_BASE}/voices/add"

    # Build multipart form data manually
    import mimetypes
    boundary = "----KortixBoundary" + os.urandom(8).hex()

    parts = []
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n{args.name}')
    if args.description:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n{args.description}')

    file_parts = []
    for filepath in args.files:
        p = Path(filepath)
        if not p.exists():
            print(f"ERROR: Sample file not found: {p}", file=sys.stderr)
            sys.exit(1)
        mime = mimetypes.guess_type(str(p))[0] or "audio/mpeg"
        file_data = p.read_bytes()
        file_parts.append((p.name, mime, file_data))

    # Assemble body
    body_bytes = b""
    for part in parts:
        body_bytes += part.encode() + b"\r\n"
    for fname, mime, fdata in file_parts:
        body_bytes += f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{fname}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
        body_bytes += fdata + b"\r\n"
    body_bytes += f"--{boundary}--\r\n".encode()

    req = urllib.request.Request(url, data=body_bytes, method="POST")
    req.add_header("xi-api-key", key)
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode())
            print(f"Voice cloned successfully!")
            print(f"  Name: {args.name}")
            print(f"  Voice ID: {result.get('voice_id', 'unknown')}")
            print(f"  Use with: python tts.py speak \"text\" --voice-id {result.get('voice_id', '')}")
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f"ERROR [{e.code}]: {error_body}", file=sys.stderr)
        sys.exit(1)


def cmd_sound(args: argparse.Namespace) -> None:
    """Generate a sound effect from a text prompt."""
    body = {
        "text": args.prompt,
    }
    if args.duration:
        body["duration_seconds"] = args.duration

    audio = api_request("POST", "/sound-generation", body=body, stream=True)

    if args.output:
        out_path = Path(args.output)
    else:
        slug = args.prompt[:40].replace(" ", "_").replace("/", "_")
        out_path = Path(f"sfx_{slug}.mp3")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(audio)
    print(f"Sound effect saved: {out_path} ({len(audio):,} bytes)")


# ── CLI Parser ───────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="tts",
        description="Kortix TTS — ElevenLabs Text-to-Speech CLI",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # speak
    p_speak = sub.add_parser("speak", help="Convert text to speech")
    p_speak.add_argument("text", help="Text to speak (use '-' for stdin, '@file' to read from file)")
    p_speak.add_argument("-o", "--output", help="Output file path")
    p_speak.add_argument("--voice", help="Voice name (e.g. 'Rachel', 'George')")
    p_speak.add_argument("--voice-id", help="Voice ID directly")
    p_speak.add_argument("--model", help="Model ID (default: eleven_multilingual_v2)")
    p_speak.add_argument("--format", help="Output format (default: mp3_44100_128)")
    p_speak.add_argument("--stability", type=float, help="Voice stability 0.0-1.0")
    p_speak.add_argument("--similarity", type=float, help="Similarity boost 0.0-1.0")
    p_speak.add_argument("--style", type=float, help="Style exaggeration 0.0-1.0")
    p_speak.add_argument("--speed", type=float, help="Speed 0.5-2.0")

    # voices
    p_voices = sub.add_parser("voices", help="List available voices")
    p_voices.add_argument("--search", help="Search/filter voices")

    # models
    sub.add_parser("models", help="List available TTS models")

    # clone
    p_clone = sub.add_parser("clone", help="Clone a voice from audio samples")
    p_clone.add_argument("name", help="Name for the cloned voice")
    p_clone.add_argument("files", nargs="+", help="Audio sample files (mp3, wav, etc.)")
    p_clone.add_argument("--description", help="Voice description")

    # batch
    p_batch = sub.add_parser("batch", help="Convert text file to speech")
    p_batch.add_argument("input_file", help="Input text file")
    p_batch.add_argument("-o", "--output", help="Output directory")
    p_batch.add_argument("--voice", help="Voice name")
    p_batch.add_argument("--voice-id", help="Voice ID directly")
    p_batch.add_argument("--model", help="Model ID")
    p_batch.add_argument("--format", help="Output format")
    p_batch.add_argument("--split-paragraphs", action="store_true", help="Split by paragraphs into separate files")

    # sound
    p_sound = sub.add_parser("sound", help="Generate sound effect from text prompt")
    p_sound.add_argument("prompt", help="Description of the sound effect")
    p_sound.add_argument("-o", "--output", help="Output file path")
    p_sound.add_argument("--duration", type=float, help="Duration in seconds")

    args = parser.parse_args()

    commands = {
        "speak": cmd_speak,
        "voices": cmd_voices,
        "models": cmd_models,
        "clone": cmd_clone,
        "batch": cmd_batch,
        "sound": cmd_sound,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
