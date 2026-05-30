---
name: hyper-fast-youtube-transcript
description: "Use when the user wants a YouTube transcript from a single URL or video ID. Optimized for one input and one output: fetch the transcript fast, default to plain transcript text only, and avoid extra commentary unless the user asks for timestamps, JSON, or metadata. Triggers on: youtube transcript, transcript from this video, get captions, extract transcript from YouTube, summarize this YouTube transcript after fetching it."
---

# Hyper Fast YouTube Transcript

Use this skill when the job is simply to get a transcript from a YouTube URL or video ID with minimal token overhead.

## Default Behavior

- Use the bundled script: `python3 skills/GENERAL-KNOWLEDGE-WORKER/hyper-fast-youtube-transcript/scripts/get_youtube_transcript.py "<youtube-url-or-id>"`
- Pass exactly one input: a full YouTube URL, `youtu.be` URL, `shorts` URL, `embed` URL, or raw video ID.
- Default output is transcript text only. Do not add timestamps, summaries, bullet points, or metadata unless the user asked for them.
- If the transcript is too long for chat, write it to a file with `--output <path>` and return the path plus a short note.

## Output Modes

- Plain transcript: default
- Timestamped transcript: add `--timestamps`
- JSON snippets: add `--json`
- Save to file: add `--output /absolute/path.txt`

## Notes

- The script auto-installs `youtube-transcript-api` if it is missing.
- Prefer English when available, but fall back to the best available transcript if needed.
- If the user wants analysis after extraction, fetch the transcript first, then do the analysis as a separate step.
