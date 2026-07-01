import type { Effect } from 'effect';
const ECHO_TTL_MS = 25_000;
const MAX_TRACKED_BOTS = 512;

// Half-duplex window: meeting captions transcribe the bot's OWN output audio and
// stream it back as "Unknown" speech, which would re-wake the agent. While the bot
// is speaking — for the estimated duration of its utterance plus a caption-lag
// buffer — we drop inbound spoken transcripts entirely. Unlike content matching this
// scales with utterance length (long monologues don't outrun a fixed TTL) and is
// immune to caption mis-hearings ("Kortix" → "cortex").
const MS_PER_WORD = 450;
const CAPTION_LAG_MS = 12_000;
const MIN_SPEAK_MS = 3_000;

const recent = new Map<string, Array<{ text: string; at: number }>>();
const speakingUntil = new Map<string, number>();

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function recordBotSpeech(botId: string, text: string): void {
  const norm = normalize(text);
  if (!botId || !norm) return;
  const now = Date.now();
  const list = (recent.get(botId) ?? []).filter((e) => now - e.at < ECHO_TTL_MS);
  list.push({ text: norm, at: now });
  recent.set(botId, list);
  if (recent.size > MAX_TRACKED_BOTS) prune(now);

  const windowMs = Math.max(MIN_SPEAK_MS, wordCount(text) * MS_PER_WORD) + CAPTION_LAG_MS;
  speakingUntil.set(botId, Math.max(speakingUntil.get(botId) ?? 0, now + windowMs));
}

/** True while the bot is (estimated to be) speaking + captions are still catching up. */
export function isBotSpeaking(botId: string): boolean {
  if (!botId) return false;
  const until = speakingUntil.get(botId);
  if (until == null) return false;
  if (Date.now() >= until) {
    speakingUntil.delete(botId);
    return false;
  }
  return true;
}

export function isBotEcho(botId: string, text: string): boolean {
  const heard = normalize(text);
  if (!botId || !heard) return false;
  const now = Date.now();
  const list = (recent.get(botId) ?? []).filter((e) => now - e.at < ECHO_TTL_MS);
  return list.some((e) => echoMatch(e.text, heard));
}

function echoMatch(spoken: string, heard: string): boolean {
  if (spoken === heard) return true;
  const spokenWords = spoken.split(' ').filter(Boolean);
  const heardWords = heard.split(' ').filter(Boolean);
  if (spokenWords.length < 4) return false;
  if (heard.includes(spoken) || spoken.includes(heard)) return true;
  if (heardWords.length < 4) return false;
  const spokenSet = new Set(spokenWords);
  const uniqueHeard = new Set(heardWords);
  let covered = 0;
  for (const w of uniqueHeard) if (spokenSet.has(w)) covered++;
  return covered / uniqueHeard.size >= 0.7;
}

function prune(now: number): void {
  for (const [id, list] of recent) {
    const live = list.filter((e) => now - e.at < ECHO_TTL_MS);
    if (live.length === 0) recent.delete(id);
    else recent.set(id, live);
  }
}
