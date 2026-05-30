#!/usr/bin/env python3

import argparse
import importlib
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def ensure_dependency():
    try:
        module = importlib.import_module("youtube_transcript_api")
    except ModuleNotFoundError:
        subprocess.check_call(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--user",
                "youtube-transcript-api",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        module = importlib.import_module("youtube_transcript_api")
    return module


def extract_video_id(value: str) -> str:
    value = value.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return value

    parsed = urlparse(value)
    host = parsed.netloc.lower()
    path = parsed.path.strip("/")

    if host in {"youtu.be", "www.youtu.be"}:
        candidate = path.split("/")[0]
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
            return candidate

    if host in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        if path == "watch":
            candidate = parse_qs(parsed.query).get("v", [""])[0]
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
                return candidate
        parts = path.split("/")
        for marker in {"embed", "shorts", "live"}:
            if marker in parts:
                idx = parts.index(marker)
                if idx + 1 < len(parts):
                    candidate = parts[idx + 1]
                    if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
                        return candidate

    raise SystemExit(f"Could not extract a valid YouTube video ID from: {value}")


def normalize_text(text: str) -> str:
    return " ".join(text.replace("\n", " ").split()).strip()


def fetch_snippets(api_module, video_id: str, language: str | None):
    api = api_module.YouTubeTranscriptApi()
    preferred_languages = [language] if language else ["en"]

    try:
        transcript = api.fetch(video_id, languages=preferred_languages)
    except Exception:
        transcript_list = api.list(video_id)
        chosen = None

        if language:
            try:
                chosen = transcript_list.find_transcript([language])
            except Exception:
                chosen = None

        if chosen is None:
            for finder_name in (
                "find_transcript",
                "find_generated_transcript",
                "find_manually_created_transcript",
            ):
                try:
                    chosen = getattr(transcript_list, finder_name)(["en"])
                    break
                except Exception:
                    continue

        if chosen is None:
            try:
                chosen = next(iter(transcript_list))
            except StopIteration as exc:
                raise SystemExit(
                    f"No transcripts available for video: {video_id}"
                ) from exc

        transcript = chosen.fetch()

    snippets = []
    for item in transcript:
        text = normalize_text(item.text)
        if not text:
            continue
        snippets.append(
            {
                "start": round(float(item.start), 2),
                "duration": round(float(item.duration), 2),
                "text": text,
            }
        )
    return snippets


def format_plain(snippets):
    return " ".join(snippet["text"] for snippet in snippets)


def format_timestamps(snippets):
    lines = []
    for snippet in snippets:
        lines.append(f"[{snippet['start']:.2f}] {snippet['text']}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Fetch a YouTube transcript fast.")
    parser.add_argument("input", help="YouTube URL or video ID")
    parser.add_argument("--language", help="Preferred language code, e.g. en")
    parser.add_argument(
        "--timestamps", action="store_true", help="Output timestamped lines"
    )
    parser.add_argument("--json", action="store_true", help="Output JSON snippets")
    parser.add_argument("--output", help="Write output to a file instead of stdout")
    args = parser.parse_args()

    if args.timestamps and args.json:
        raise SystemExit("Use either --timestamps or --json, not both.")

    api_module = ensure_dependency()
    video_id = extract_video_id(args.input)
    snippets = fetch_snippets(api_module, video_id, args.language)

    if args.json:
        output = json.dumps(
            {"video_id": video_id, "snippets": snippets}, ensure_ascii=False, indent=2
        )
    elif args.timestamps:
        output = format_timestamps(snippets)
    else:
        output = format_plain(snippets)

    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(output + "\n", encoding="utf-8")
        print(path)
        return

    sys.stdout.write(output)
    if not output.endswith("\n"):
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
