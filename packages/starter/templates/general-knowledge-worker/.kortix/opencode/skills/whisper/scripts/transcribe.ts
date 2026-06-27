#!/usr/bin/env bun
/**
 * Whisper Audio Transcription CLI
 *
 * Transcribes audio/video files to text using the fastest available provider:
 *   1. Groq Whisper (fastest — near-instant)
 *   2. OpenAI Whisper (reliable fallback)
 *
 * Usage:
 *   bun run transcribe.ts --file /path/to/audio.ogg
 *   bun run transcribe.ts --file /path/to/audio.mp3 --language en
 *   bun run transcribe.ts --file /path/to/video.mp4 --timestamps
 *
 * Supported: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, oga, flac
 * Auth: GROQ_API_KEY (preferred) or OPENAI_API_KEY
 * Output: JSON always.
 */

import { readFileSync, existsSync } from "node:fs"

// ─── Env resolution (s6 → process.env fallback) ─────────────────────────────

function getEnv(key: string): string | undefined {
  // Try common s6 env paths
  for (const dir of [
    process.env.S6_ENV_DIR,
    "/run/s6/container_environment",
    "/var/run/s6/container_environment",
  ]) {
    if (!dir) continue
    try {
      const val = readFileSync(`${dir}/${key}`, "utf-8").trim()
      if (val) return val
    } catch {}
  }
  return process.env[key] || undefined
}

// ─── Transcription ──────────────────────────────────────────────────────────

interface TranscribeOpts {
  file: string
  language?: string
  timestamps?: boolean
  prompt?: string
}

export async function transcribe(opts: TranscribeOpts): Promise<any> {
  const groqKey = getEnv("GROQ_API_KEY")
  const openaiKey = getEnv("OPENAI_API_KEY")

  if (!groqKey && !openaiKey) {
    return { ok: false, error: "No API key. Set GROQ_API_KEY (fastest) or OPENAI_API_KEY." }
  }

  if (!existsSync(opts.file)) {
    return { ok: false, error: `File not found: ${opts.file}` }
  }

  const fileData = readFileSync(opts.file)
  const ext = opts.file.split(".").pop()?.toLowerCase() || "ogg"
  const mimeMap: Record<string, string> = {
    mp3: "audio/mpeg", mp4: "video/mp4", mpeg: "audio/mpeg", mpga: "audio/mpeg",
    m4a: "audio/mp4", wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg",
    oga: "audio/ogg", flac: "audio/flac",
  }
  const mime = mimeMap[ext] || "audio/ogg"
  const filename = opts.file.split("/").pop() || `audio.${ext}`

  const formData = new FormData()
  formData.append("file", new Blob([fileData], { type: mime }), filename)
  formData.append("model", groqKey ? "whisper-large-v3" : "whisper-1")
  formData.append("response_format", opts.timestamps ? "verbose_json" : "json")
  if (opts.language) formData.append("language", opts.language)
  if (opts.prompt) formData.append("prompt", opts.prompt)

  const providers = [
    ...(groqKey ? [{ name: "groq", url: "https://api.groq.com/openai/v1/audio/transcriptions", key: groqKey }] : []),
    ...(openaiKey ? [{ name: "openai", url: "https://api.openai.com/v1/audio/transcriptions", key: openaiKey }] : []),
  ]

  for (const provider of providers) {
    try {
      const res = await fetch(provider.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.key}` },
        body: formData,
        signal: AbortSignal.timeout(120_000),
      })

      if (!res.ok) {
        const errText = await res.text()
        console.error(`[whisper] ${provider.name} ${res.status}: ${errText.slice(0, 200)}`)
        continue
      }

      const data = await res.json() as any
      return {
        ok: true,
        text: data.text,
        provider: provider.name,
        language: data.language,
        duration: data.duration,
        ...(opts.timestamps && data.segments ? { segments: data.segments } : {}),
      }
    } catch (e) {
      console.error(`[whisper] ${provider.name} failed: ${e}`)
      continue
    }
  }

  return { ok: false, error: "All transcription providers failed." }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const val = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : "true"
      flags[key] = val
    }
  }
  return flags
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv)

  if (flags.help || (!flags.file && !flags.help)) {
    console.log(`Whisper Transcription CLI\nUsage: bun run transcribe.ts --file <path> [--language <code>] [--timestamps] [--prompt <hint>]`)
    if (!flags.file) process.exit(1)
    return
  }

  const result = await transcribe({
    file: flags.file,
    language: flags.language,
    timestamps: flags.timestamps === "true",
    prompt: flags.prompt,
  })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.log(JSON.stringify({ ok: false, error: String(err) }))
    process.exit(1)
  })
}
